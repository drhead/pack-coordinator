"""Test wait_for_next_refresh functionality."""

import asyncio
from app.post_worker import wait_for_next_refresh, _notify_tick_completed


async def test_wait():
    print("Testing wait_for_next_refresh...")
    
    async def waiter(idx: int):
        print(f"Waiter {idx} waiting...")
        res = await wait_for_next_refresh(timeout=2.0)
        print(f"Waiter {idx} woken up! (Result: {res})")
        return res

    # Start 3 waiters
    tasks = [asyncio.create_task(waiter(i)) for i in range(3)]
    await asyncio.sleep(0.05)

    print("Triggering tick completion...")
    _notify_tick_completed()

    results = await asyncio.gather(*tasks)
    assert all(results), "Not all waiters succeeded"
    print("✓ All waiters woken up successfully!")


if __name__ == "__main__":
    asyncio.run(test_wait())
