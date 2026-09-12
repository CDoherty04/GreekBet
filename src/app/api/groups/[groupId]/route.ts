/**
 * /api/groups/[groupId] — group details + its members.
 *
 * Non-members can still fetch a public preview (name + member count) so an
 * invite link like `/groups/{id}` can show a Join screen.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { scheduleDueSettlements, toMarketView } from "@/lib/markets";
import { projection } from "@/lib/chain/projection";
import type { User } from "@/types";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/groups/[groupId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = await db.getGroup(groupId);
  if (!group) return fail("Group not found", 404);

  const isMember = group.memberIds.includes(user.id);

  const members = (
    await Promise.all(group.memberIds.map((id) => db.getUser(id)))
  ).filter((u): u is User => Boolean(u));

  // One projection read for the whole list rather than per market.
  const chain = projection();
  const allMarkets = await db.listMarketsForGroup(groupId);
  // Settle due resolutions after responding; this list may lag by one load.
  scheduleDueSettlements(allMarkets, (address) => chain.get(address));
  const markets = await Promise.all(
    allMarkets
      .filter((m) => !m.archived)
      .map((m) => toMarketView(m, chain.get(m.address), user.walletAddress)),
  );

  if (!isMember) {
    // A non-member sees the market list as a preview, but nothing that ties a
    // person to a wallet — the addresses are on a public chain, and joining
    // them to names here would leak who traded what to anyone with the link.
    const publicMembers = members.map((u) => ({
      ...u,
      phone: "",
      walletAddress: "",
      worldId: "",
    }));
    return ok({
      group: { ...group, code: "", memberIds: [] },
      members: publicMembers,
      // Titles and odds are fine as a teaser, but the trade list joins wallet
      // addresses back to names — that is exactly what a non-member must not
      // see, so it is stripped rather than merely hidden in the UI.
      markets: markets.map((m) => ({ ...m, trades: [], myPosition: undefined })),
      isMember: false,
      memberCount: members.length,
    });
  }

  return ok({
    group,
    members,
    markets,
    isMember: true,
    memberCount: members.length,
  });
}
