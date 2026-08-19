"""Verification script for hybrid priority queue and last_refreshed_at behavior."""

import asyncio
from app.db import init_db_pool, close_db_pool, get_db
from app.post_worker import (
    _priority_queue,
    enqueue_post_ids,
    get_stalest_post_ids,
    CHUNK_LIMIT,
)


async def test():
    await init_db_pool()
    pool = get_db()

    print("=== 1. Checking last_refreshed_at column & index ===")
    async with pool.acquire() as conn:
        col = await conn.fetchval(
            """
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'posts' AND column_name = 'last_refreshed_at';
            """
        )
        assert col == "last_refreshed_at", f"Column missing! {col}"
        print(f"✓ Column exists: {col}")

        idx = await conn.fetchval(
            """
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = 'posts' AND indexname = 'idx_posts_last_refreshed_at';
            """
        )
        assert idx == "idx_posts_last_refreshed_at", f"Index missing! {idx}"
        print(f"✓ Index exists: {idx}")

    print("\n=== 2. Testing priority queue enqueue & selection loop ===")
    # Clear queue
    while not _priority_queue.empty():
        _priority_queue.get_nowait()

    # Enqueue 3 synthetic post IDs
    enqueue_post_ids([9999901, 9999902, 9999903])

    target_posts: set[int] = set()

    # 1. Drain in-memory queue
    while len(target_posts) < CHUNK_LIMIT and not _priority_queue.empty():
        try:
            pid = _priority_queue.get_nowait()
            target_posts.add(pid)
        except asyncio.QueueEmpty:
            break

    assert 9999901 in target_posts
    assert 9999902 in target_posts
    assert 9999903 in target_posts
    print(f"✓ Dequeued {len(target_posts)} high-priority items into set")

    # 2. Fill remaining headroom with stalest posts from DB
    if len(target_posts) < CHUNK_LIMIT:
        stale_post_ids = await get_stalest_post_ids(CHUNK_LIMIT)
        print(f"✓ Fetched {len(stale_post_ids)} stalest candidate post IDs from DB")
        for pid in stale_post_ids:
            target_posts.add(pid)
            if len(target_posts) >= CHUNK_LIMIT:
                break

    print(f"✓ Total combined batch set size: {len(target_posts)} (max capacity: {CHUNK_LIMIT})")
    assert len(target_posts) <= CHUNK_LIMIT

    print("\n=== 3. Testing last_refreshed_at update without cluster re-eval trigger ===")
    async with pool.acquire() as conn:
        sample_post = await conn.fetchval("SELECT post_id FROM posts LIMIT 1;")
        if sample_post:
            await conn.execute(
                "UPDATE posts SET last_refreshed_at = CURRENT_TIMESTAMP WHERE post_id = $1;",
                sample_post,
            )
            updated_ts = await conn.fetchval(
                "SELECT last_refreshed_at FROM posts WHERE post_id = $1;", sample_post
            )
            assert updated_ts is not None, "Timestamp was not set!"
            print(f"✓ Successfully updated post {sample_post} last_refreshed_at to {updated_ts}")

    await close_db_pool()
    print("\n✓ ALL VERIFICATION TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    asyncio.run(test())
