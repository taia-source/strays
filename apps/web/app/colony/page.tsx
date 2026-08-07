/**
 * `/colony` → `/app`.
 *
 * The colony moved to `/app` when it became a live canvas world rather than a grid of portraits.
 * This route is kept as a permanent redirect rather than deleted because `/colony` is in
 * `DESIGN.md` §8's route table, on the landing page's old markup, and in whatever screenshots and
 * links already exist — and a 404 on a route the project's own design document names is the kind of
 * rot that gets discovered by a user rather than by us.
 *
 * `permanentRedirect` (308) rather than `redirect` (307): the move is permanent, and a 308 lets
 * crawlers and browsers transfer the old URL's standing to the new one instead of re-checking it
 * forever.
 */
import { permanentRedirect } from "next/navigation";

export default function ColonyMoved(): never {
  permanentRedirect("/app");
}
