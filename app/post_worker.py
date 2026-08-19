"""Posts worker service with hybrid priority queue and stalest-first background refresh."""

from typing import Any
import logging
import asyncio

import httpx
import msgspec

from app.db import get_db
from app.config import settings
from app.rate_limiter import e621_limiter
from app.structs import PostData
from app.flag_worker import refresh_post_flags

USER_AGENT = f"cleanup-coordinator_posts-worker/1.2 (by {settings.e621_username})"

POSTS_URL = "https://e621.net/posts.json"
CHUNK_LIMIT = 320
REFRESH_INTERVAL_SECONDS = 5.0

logger = logging.getLogger("PostsWorker")

_priority_queue: asyncio.Queue[int] = asyncio.Queue()


def format_pg_text_array(elements: list[str]) -> str:
    """Formats a list of strings into a valid, safe PostgreSQL text array literal.

    Each element is wrapped in double quotes, with internal backslashes and double quotes escaped.
    """
    escaped = [
        '"' + elem.replace('\\', '\\\\').replace('"', '\\"') + '"'
        for elem in elements
    ]
    return "{" + ",".join(escaped) + "}"


def format_pg_int_array(elements: list[int]) -> str:
    """Formats a list of integers into a valid PostgreSQL integer array literal."""
    return "{" + ",".join(str(x) for x in elements) + "}"


class PostsResponse(msgspec.Struct):
    posts: list[PostData]


post_decoder = msgspec.json.Decoder(type=PostsResponse)


def enqueue_post_ids(post_ids: list[int] | set[int] | int) -> None:
    """Enqueues post ID(s) into the high-priority in-memory queue."""
    if isinstance(post_ids, int):
        _priority_queue.put_nowait(post_ids)
    else:
        for pid in post_ids:
            _priority_queue.put_nowait(pid)


async def refresh_batch_posts(batch_id: int) -> None:
    """Fetches all post IDs in a batch and enqueues them for priority refresh."""
    try:
        pool = get_db()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT cp.post_id FROM cluster_posts cp
                JOIN clusters c ON cp.cluster_id = c.cluster_id
                WHERE c.batch_id = $1;
                """,
                batch_id,
            )
            post_ids = [r["post_id"] for r in rows]

        if post_ids:
            enqueue_post_ids(post_ids)

    except Exception as e:
        logger.error(f"[PostsWorker] Error enqueuing batch #{batch_id}: {e}")


async def get_stalest_post_ids(limit: int = CHUNK_LIMIT) -> list[int]:
    """Retrieves up to `limit` stalest posts ordered by last_refreshed_at ASC NULLS FIRST."""
    pool = get_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT post_id
            FROM posts
            ORDER BY last_refreshed_at ASC NULLS FIRST
            LIMIT $1;
            """,
            limit,
        )
        return [r["post_id"] for r in rows]


async def refresh_posts_metadata(
    post_ids: list[int], client: httpx.AsyncClient | None = None
) -> list[dict[str, Any]]:
    """Fetches canonical post metadata from e621 in chunks and updates posts directly."""
    if not post_ids:
        return []

    should_close_client = False
    if client is None:
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=30.0)
        should_close_client = True

    updated_posts: list[dict[str, Any]] = []
    pool = get_db()

    try:
        for i in range(0, len(post_ids), CHUNK_LIMIT):
            chunk = post_ids[i : i + CHUNK_LIMIT]
            id_filter = f"status:any id:{','.join(map(str, chunk))}"

            await e621_limiter.wait_async()

            response = await client.get(
                POSTS_URL,
                params={"tags": id_filter, "limit": len(chunk)},
            )

            if response.status_code == 429:
                logger.warning("[PostsWorker] Hit 429 rate limit during bulk fetch!")
                break

            response.raise_for_status()
            posts = post_decoder.decode(response.content).posts

            # Update last_refreshed_at for all requested post IDs so missing/deleted posts don't stall the queue
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE posts
                    SET last_refreshed_at = CURRENT_TIMESTAMP
                    WHERE post_id = ANY($1::bigint[]);
                    """,
                    chunk,
                )

            chunk_post_ids = [post.id for post in posts]
            local_states: dict[int, tuple[bool, bool]] = {}

            if chunk_post_ids:
                async with pool.acquire() as conn:
                    rows = await conn.fetch(
                        """
                        SELECT post_id, is_flagged, is_deleted
                        FROM cluster_post_flags
                        WHERE post_id = ANY($1::bigint[]);
                        """,
                        chunk_post_ids,
                    )
                    local_states = {
                        r["post_id"]: (
                            bool(r["is_flagged"]),
                            bool(r["is_deleted"]),
                        )
                        for r in rows
                    }

            records_to_update: list[tuple[int | None, list[int], list[str], str, int]] = []

            for post in posts:
                local_flagged, local_deleted = local_states.get(post.id, (False, False))
                if (
                    local_flagged != post.flags.flagged
                    or local_deleted != post.flags.deleted
                ):
                    await refresh_post_flags(post.id, client)

                flat_tags = post.flat_tags()
                parent_id = post.relationships.parent_id
                rating = post.rating
                pool_ids = post.pools

                records_to_update.append(
                    (parent_id, pool_ids, flat_tags, rating, post.id)
                )

                updated_posts.append(
                    {
                        "post_id": post.id,
                        "parent_id": parent_id,
                        "pool_ids": pool_ids,
                        "rating": rating,
                        "tags": flat_tags,
                    }
                )

            if records_to_update:
                parent_ids, pool_ids_list, tags_list, ratings, target_post_ids = zip(*records_to_update)

                # Format Python lists into safe PostgreSQL array string literals
                formatted_pool_ids = [format_pg_int_array(p) for p in pool_ids_list]
                formatted_tags = [format_pg_text_array(t) for t in tags_list]

                async with pool.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE posts p
                        SET parent_id = u.parent_id,
                            pool_ids = u.pool_ids::int[],
                            tags = u.tags::text[],
                            rating = u.rating
                        FROM UNNEST(
                            $1::bigint[],
                            $2::text[],
                            $3::text[],
                            $4::text[],
                            $5::bigint[]
                        ) AS u(parent_id, pool_ids, tags, rating, post_id)
                        WHERE p.post_id = u.post_id
                        AND (
                            p.parent_id IS DISTINCT FROM u.parent_id OR
                            p.pool_ids IS DISTINCT FROM u.pool_ids::int[] OR
                            p.tags IS DISTINCT FROM u.tags::text[] OR
                            p.rating IS DISTINCT FROM u.rating
                        );
                        """,
                        list(parent_ids),
                        formatted_pool_ids,
                        formatted_tags,
                        list(ratings),
                        list(target_post_ids),
                    )

    except Exception as e:
        logger.error(f"[PostsWorker] Error during bulk fetch: {e}")
    finally:
        if should_close_client:
            await client.aclose()

    return updated_posts


_tick_event: asyncio.Event = asyncio.Event()


def _notify_tick_completed() -> None:
    """Wakes up any coroutines waiting for this refresh cycle and resets the event."""
    global _tick_event
    current = _tick_event
    _tick_event = asyncio.Event()
    current.set()


async def wait_for_next_refresh(timeout: float = 10.0) -> bool:
    """Waits until the post worker completes its next refresh cycle.

    Returns True if a refresh cycle completed, or False if timeout elapsed.
    """
    current = _tick_event
    try:
        await asyncio.wait_for(current.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False


async def post_worker_loop() -> None:
    """Background worker loop managing the hybrid priority queue.

    Every 5 seconds:
    1. Pops up to CHUNK_LIMIT items from the high-priority in-memory queue.
    2. If fewer than CHUNK_LIMIT items are queued, fills remaining capacity
       with stalest posts from the database (ORDER BY last_refreshed_at ASC NULLS FIRST).
    3. Refreshes metadata for all selected posts in a single unified operation.
    4. Notifies any waiting endpoints that a refresh cycle completed.
    """
    logger.info("[PostsWorker] Starting 5-second hybrid priority queue worker loop...")
    client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=30.0)

    try:
        while True:
            try:
                target_posts: set[int] = set()

                # 1. Drain up to CHUNK_LIMIT items from in-memory queue
                while len(target_posts) < CHUNK_LIMIT and not _priority_queue.empty():
                    try:
                        post_id = _priority_queue.get_nowait()
                        target_posts.add(post_id)
                    except asyncio.QueueEmpty:
                        break

                # 2. Fill remaining capacity with stalest posts from DB
                if len(target_posts) < CHUNK_LIMIT:
                    stale_post_ids = await get_stalest_post_ids(CHUNK_LIMIT)
                    for pid in stale_post_ids:
                        target_posts.add(pid)
                        if len(target_posts) >= CHUNK_LIMIT:
                            break

                # 3. Refresh metadata if any posts were gathered
                if target_posts:
                    await refresh_posts_metadata(list(target_posts), client=client)

            except asyncio.CancelledError:
                logger.info("[PostsWorker] Worker loop received cancellation.")
                raise
            except Exception as e:
                logger.error(f"[PostsWorker] Error in worker tick: {e}", exc_info=True)
            finally:
                _notify_tick_completed()

            await asyncio.sleep(REFRESH_INTERVAL_SECONDS)

    finally:
        await client.aclose()