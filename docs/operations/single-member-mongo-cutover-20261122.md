# ACG Trader MongoDB single-member migration — 22 November 2026

## Scope
Only Railway project `zucchini-enjoyment` (2c77c657-8a52-4741-8e4e-44c936de5f92),
environment production (2efecdfb-9fc4-468e-ad5d-7c3bcd24e332).
**Not** ACG Funded, acg-quant-research or acg-pr72-acceptance.

## Original replica set (rs0)
| Service | Service ID | Volume ID |
| --- | --- | --- |
| MongoDB-1 | 5c37a765-c92a-4773-bf73-b6d043173aa0 | 6b53fdcf-7ab7-445c-b9b6-271ec2106a40 |
| MongoDB-2 | 71a38268-e7ec-4cc3-939d-8de223049df0 | c2511b0f-712a-4336-8401-729bbf4c8b9f |
| MongoDB-3 | 2412ced5-2a41-4fca-b55e-a94efc424037 | 1f3365a6-15f9-415f-ac25-0e1334c0ebae |
| MongoDB HA | 1a9978cd-ecc3-45c9-abe0-a4c402abb17a | none |

Original Mongo image `ghcr.io/railwayapp-templates/mongo-ha/mongo:8.0`;
HAProxy image `ghcr.io/railwayapp-templates/mongo-ha/haproxy:3.2`.
All original volumes are 5 GB and mounted `/data/db` in
`europe-west4-drams3a`. **Retain old volumes if services are removed.**

## New single-member service
Service `acg-mongo-single-candidate` id cbf29d3c-2cd4-4d6a-a5d9-eec10e9a0387,
volume `acg-mongo-single-candidate-data` id
f29b5ab4-e86b-43aa-96df-20a882a5bb1d, 5 GB, `/data/db`.
MongoDB 8.0; `acg_single` single-voter replica set; 1.5 GB WiredTiger cache,
temporary 6 GB memory limit / 1 vCPU; private endpoint
`acg-mongo-single-candidate.railway.internal:27017`.
Bootstrap source branch: `ops/single-member-mongo-20261122`.
Credentials are stored as Railway service variables; **do not copy them to Git**.

## Data and acceptance evidence
- Nov 22 03:05 UTC: pre-migration full archived backup from original rs0,
  prefix `acg-trader-baselines/20261122T030404Z`.
- Nov 22 ~04:01 UTC: candidate confirmed single PRIMARY and majority-acknowledged
  MongoDB transaction passed. Effective WiredTiger max: 1,610,612,736 bytes.
- Nov 22 04:07 UTC: Trader backend entered maintenance, trading/Mongo write engines stopped.
- Nov 22 04:11 UTC: FINAL copy from rs0 to `acg_single` finished; complete
  per-collection document counts and index-key sets matched for `acg_trader`
  and `acg_trader_staging`.
- Source critical collections at final copy: tradingaccounts 101, positions 728,
  orders 1545, deals 1461, accountledgers 2080, idempotencyrecords 61.
- Nov 22 04:12 UTC: backend connected to candidate and verified critical indexes;
  private DNS/network telemetry confirmed destination.
- Nov 22 04:14 UTC: fresh backup from new database,
  prefix `acg-trader-baselines/20261122T041358Z`; isolated restore verified.

## Rollback and safety
If trading/API errors appear, freeze all trading writes with
`ACG_DB_MIGRATION_MAINTENANCE=true` before altering any connection URI.
Do not simply point the app back to rs0 after new writes: this can discard
transactions committed to `acg_single`. Reconcile the authoritative newest
data into the chosen recovery target first, then verify risk/ledger invariants,
transactions, critical indexes, open positions, orders and auth. If necessary,
restore the verified `acg-trader-baselines` archives into a separate database.
The old replica volumes preserve original data but not their service
credentials after the services are deleted; credentials must be recovered
securely or auth reset through an authorized recovery procedure before using
the volumes. Never restore onto a live production volume.

## Outstanding validation
Collect measured post-cutover working set and production latency, establish
an external/off-region copy of archives and test full disaster recovery and
point-in-time recovery where feasible. A daily snapshot alone does not
guarantee zero RPO after a catastrophic storage loss.
