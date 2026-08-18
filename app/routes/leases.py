"""Leases router migrated to async PostgreSQL."""

import msgspec
from fastapi import APIRouter, Request, Response

from app.db import get_db
from app.leases import clear_expired_leases, get_client_ip

router = APIRouter()


class Lease(msgspec.Struct, rename="camel", kw_only=True):
    project_id: str
    batch_id: int
    batch_number: int
    leased_until: str | None = None
    is_leased_by_you: bool = False


class LeasesResponse(msgspec.Struct, rename="camel", kw_only=True):
    leases: list[Lease]


json_encoder = msgspec.json.Encoder()


@router.get("/api/v1/leases")
async def get_leases(request: Request) -> Response:
    await clear_expired_leases()
    client_ip = get_client_ip(request)

    pool = get_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT 
                l.project_id,
                l.batch_id,
                l.expires_at AS leased_until,
                b.batch_number,
                (l.ip_address = $1) AS is_leased_by_you
            FROM leases l
            JOIN batches b ON l.batch_id = b.batch_id
            ORDER BY l.expires_at ASC
            """,
            client_ip,
        )

        leases_list = [
            Lease(
                project_id=r["project_id"],
                batch_id=r["batch_id"],
                batch_number=r["batch_number"],
                leased_until=r["leased_until"].isoformat() if r["leased_until"] else None,
                is_leased_by_you=bool(r["is_leased_by_you"]),
            )
            for r in rows
        ]

        return Response(
            content=json_encoder.encode(LeasesResponse(leases=leases_list)),
            media_type="application/json",
        )