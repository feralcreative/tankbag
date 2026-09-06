// Who is on which stretch of road, query side. The rules are in ./policy.ts and
// nothing here re-decides one.
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { dayRiders, days as daysTable, rideMembers } from '../db/schema'
import type { Tx } from '../maps/ride-graph'
import { resolveRouteRiders, type DayRiderRef, type ResolvedDay } from './policy'

/**
 * Bring `day_riders` into line with the routes the payload actually carries.
 *
 * **THE SAME OBLIGATION `reconcileVotes` AND `writePointDetails` HAVE, AND FOR
 * THE SAME REASON.** These rows cascade from `rides` and key on `days.uid`, not
 * on `days.id` — because the builder's PUT deletes and re-inserts every route on
 * every save — so nothing else cleans them up. Skip this and a deleted route
 * keeps its roster forever, and a uid that later gets reused inherits it.
 *
 * Called from `insertRideGraph`, beside the other two.
 */
export async function reconcileDayRiders(tx: Tx, rideId: number, liveDayUids: string[]): Promise<void> {
  if (liveDayUids.length === 0) {
    await tx.delete(dayRiders).where(eq(dayRiders.rideId, rideId))
    return
  }
  const rows = await tx.select({ dayUid: dayRiders.dayUid }).from(dayRiders).where(eq(dayRiders.rideId, rideId))
  const live = new Set(liveDayUids)
  const doomed = [...new Set(rows.map((r) => r.dayUid))].filter((uid) => !live.has(uid))
  if (doomed.length > 0) {
    // inArray, never a JS array interpolated into a tagged `sql` template —
    // drizzle expands one into a tuple and `= any((...))` is not valid SQL.
    await tx.delete(dayRiders).where(and(eq(dayRiders.rideId, rideId), inArray(dayRiders.dayUid, doomed)))
  }
}

/** The stored overrides for a ride. Rows are an override and their absence means
 *  "inherit" — see resolveRouteRiders, which is the only place that rule lives. */
export async function dayRiderRefs(rideId: number): Promise<DayRiderRef[]> {
  return db
    .select({ dayUid: dayRiders.dayUid, riderId: dayRiders.riderId })
    .from(dayRiders)
    .where(eq(dayRiders.rideId, rideId))
}

/**
 * Every route of a ride with the riders actually on it.
 *
 * **THREE READS AND NOT A JOIN**, deliberately: the resolution is a WALK in
 * position order that carries a set forward, so it cannot be expressed as a
 * per-row join anyway — and the roster is an argument rather than a lookup
 * inside the rule, because adding a rider to the ride has to change every
 * inherited route with no write.
 */
export async function resolvedRoutes(rideId: number): Promise<ResolvedDay[]> {
  const [routes, refs, roster] = await Promise.all([
    db
      .select({ uid: daysTable.uid, position: daysTable.position })
      .from(daysTable)
      .where(eq(daysTable.rideId, rideId))
      .orderBy(daysTable.position),
    dayRiderRefs(rideId),
    db.select({ riderId: rideMembers.riderId }).from(rideMembers).where(eq(rideMembers.rideId, rideId)),
  ])
  return resolveRouteRiders(
    routes,
    refs,
    roster.map((r) => r.riderId),
  )
}

/**
 * Set exactly who is on one route, replacing whatever it said.
 *
 * **AN EMPTY LIST CLEARS THE OVERRIDE RATHER THAN EMPTYING THE ROUTE.** A route
 * ridden by nobody is not a thing anyone means, so "nobody" is how a planner
 * says "go back to inheriting from the route before this one" — which is the
 * only way to undo an answer, and the reason the absence of rows is unambiguous.
 *
 * Delete-then-insert rather than a diff: a route's roster is small, this runs on
 * a deliberate press rather than on a timer, and a diff is two more states to
 * get wrong.
 */
export async function setRouteRiders(rideId: number, dayUid: string, riderIds: number[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(dayRiders).where(and(eq(dayRiders.rideId, rideId), eq(dayRiders.dayUid, dayUid)))
    if (riderIds.length === 0) return
    // Only riders actually on the ride. A stranger's id reaching this table
    // would resolve to nothing anyway — policy filters against the roster — but
    // storing it is a row nothing will ever clean up.
    const roster = await tx
      .select({ riderId: rideMembers.riderId })
      .from(rideMembers)
      .where(eq(rideMembers.rideId, rideId))
    const allowed = new Set(roster.map((r) => r.riderId))
    const values = [...new Set(riderIds)]
      .filter((id) => allowed.has(id))
      .map((riderId) => ({ rideId, dayUid, riderId }))
    if (values.length > 0) await tx.insert(dayRiders).values(values)
  })
}
