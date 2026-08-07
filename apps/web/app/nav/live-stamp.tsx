"use client";

/**
 * "LIVE · read Ns ago", and the auto-refresh that makes it true.
 *
 * ══ WHY THE REFRESH IS `router.refresh()` AND NOT A FETCH ══
 *
 * The panel routes are SERVER components reading chain. A client-side fetch would need a parallel
 * API route returning the same rows in a different shape — two code paths for one list, and the
 * one that rots is the one nobody looks at. `router.refresh()` re-runs the server component and
 * streams the new markup in, so the list has exactly one implementation.
 *
 * ══ WHY THE ELAPSED COUNTER STARTS AT ZERO INSTEAD OF READING THE CLOCK ══
 *
 * A server-rendered "3s ago" and a client-hydrated "0s ago" is a hydration mismatch (React #418),
 * and the fix is not to suppress the warning — it is for the first client render to be identical
 * to the server's. The mount effect starts the clock; before it fires, this renders "just now",
 * which is what the server also renders because the server's read IS just now.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function LiveStamp({ intervalSec = 15 }: { readonly intervalSec?: number }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      /*
       * Do not refresh a tab nobody is looking at.
       *
       * A backgrounded tab left open overnight would otherwise fire ~5,700 chain reads. The
       * visibility check is the whole difference between a live page and a page that quietly
       * hammers an RPC endpoint for a viewer who is not there.
       */
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setElapsed(0);
    }, intervalSec * 1000);
    return () => clearInterval(id);
  }, [router, intervalSec]);

  return (
    <p className="panel-live">
      LIVE · {elapsed < 2 ? "just now" : `${elapsed}s ago`}
    </p>
  );
}
