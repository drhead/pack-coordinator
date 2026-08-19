"""Test script for POST /api/v1/posts/{post_id}/refresh endpoint."""

import asyncio
import httpx


async def test_endpoint():
    # Fetch a post_id from the dev database or a known post
    from app.db import init_db_pool, close_db_pool, get_db
    await init_db_pool()
    pool = get_db()
    async with pool.acquire() as conn:
        post_id = await conn.fetchval("SELECT post_id FROM posts LIMIT 1;")
    await close_db_pool()

    if not post_id:
        print("No posts found in database to test.")
        return

    print(f"Testing POST /api/v1/posts/{post_id}/refresh against local server...")
    async with httpx.AsyncClient(base_url="http://localhost:8623") as client:
        res = await client.post(f"/api/v1/posts/{post_id}/refresh")
        print(f"Status: {res.status_code}")
        print(f"Body: {res.text}")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.json()
        assert data.get("status") == "success"
        assert data.get("postId") == post_id
        print("✓ Single post refresh endpoint responded successfully!")


if __name__ == "__main__":
    asyncio.run(test_endpoint())
