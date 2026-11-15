import { StoreItem } from "../interfaces/store";
import { FindingCode } from "./policy";

/*
 * Cheap checks before the AI (L.2). Two kinds of result:
 *   - hints: keyword matches passed to the AI as "places to look", and used to pick which item
 *     images it sees. On their own they flag nothing: "whatsapp", "vape" or "replica" can be
 *     harmless ("a WhatsApp-style phone case").
 *   - hard flags: patterns with no innocent use in a catalogue (a crypto wallet address). These
 *     send the store to review even if the AI passes it, because payment outside checkout
 *     bypasses Stripe and the commission.
 */
export interface RuleHit {
  itemId: string | null;
  code: FindingCode;
  evidence: string;
}

export interface RuleResult {
  hints: RuleHit[];
  hardFlags: RuleHit[];
}

/* Text the merchant wrote that a shopper sees: the store's name and description, the items. */
export interface CheckedText {
  storeName: string;
  storeDescription: string;
  items: Pick<StoreItem, "storeItemId" | "storeItemName" | "storeItemDescription" | "storeItemPrices">[];
}

const HINTS: [FindingCode, RegExp][] = [
  ["OFF_PLATFORM_PAYMENT", /\b(e-?transfer|interac|zelle|venmo|cash ?app|paypal\.me|western union|moneygram|wire transfer|pay (?:me )?(?:via|by|with|through|on) (?:whatsapp|telegram|signal|crypto|bitcoin|btc|usdt|gift ?cards?))\b/i],
  ["OFF_PLATFORM_PAYMENT", /\b(whatsapp|telegram|dm (?:me )?(?:to|for) (?:order|pay|buy|price))\b/i],
  ["COUNTERFEIT", /\b(replica|1:1|aaa\+?|mirror quality|dupe|knock-?off|inspired by|unbranded (?:gucci|louis|chanel|rolex|nike))\b/i],
  ["TOBACCO_OR_VAPE", /\b(vapes?|vaping|e-?liquid|e-?juice|nicotine|cigarettes?|cigars?|hookah|shisha)\b/i],
  ["CBD_HEMP_OR_KRATOM", /\b(cbd|thc|delta-?[89]|hemp extract|kratom|kava|psilocybin|magic mushrooms?)\b/i],
  ["PRESCRIPTION_OR_PEPTIDES", /\b(peptides?|sarms?|steroids?|research chemicals?|semaglutide|ozempic|tirzepatide|no prescription)\b/i],
  ["WEAPONS", /\b(ammo|ammunition|firearms?|handguns?|rifles?|glock|ar-?15|suppressor|silencer|switchblade|brass knuckles|stun gun|taser|fireworks?)\b/i],
  ["WEAPON_ADJACENT", /\b(pepper spray|crossbow|airsoft|bb gun|tactical knife|hunting knife|body armou?r)\b/i],
  ["ALCOHOL", /\b(vodka|whisk(?:e)?y|rum|tequila|gin|liqueur|brandy|bourbon|beer|wine|cider|sake|spirits?)\b/i],
  ["RESOLD_DIGITAL_GOODS", /\b(netflix account|spotify premium|game keys?|steam keys?|license keys?|licence keys?|lifetime account)\b/i],
  ["MONEY_TRANSFER_OR_GIFT_CARDS", /\b(gift ?cards? (?:for|from) (?:amazon|apple|google|steam|visa)|prepaid (?:visa|card))\b/i],
  ["PYRAMID_OR_GET_RICH_QUICK", /\b(make \$?\d+[k]? (?:a|per) (?:day|week|month)|passive income|financial freedom|get rich|recruit)\b/i],
  ["PHANTOM_PRODUCT", /\b(lorem ipsum|test item|asdf|placeholder|deposit only)\b/i],
];

/* Crypto wallet addresses: Bitcoin (legacy and bech32), Ethereum/USDT-ERC20, Tron/USDT-TRC20. */
const WALLET = /\b(?:bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33})\b/;

const snippet = (text: string, at: number, len: number) =>
  text.slice(Math.max(0, at - 30), Math.min(text.length, at + len + 30)).replace(/\s+/g, " ").trim();

function scan(text: string, itemId: string | null, out: RuleResult): void {
  if (!text) return;
  for (const [code, re] of HINTS) {
    const m = re.exec(text);
    if (m) out.hints.push({ itemId, code, evidence: snippet(text, m.index, m[0].length) });
  }
  const w = WALLET.exec(text);
  if (w) out.hardFlags.push({ itemId, code: "OFF_PLATFORM_PAYMENT", evidence: `crypto wallet address: ${snippet(text, w.index, w[0].length)}` });
}

export function runRuleChecks(t: CheckedText): RuleResult {
  const out: RuleResult = { hints: [], hardFlags: [] };
  scan(`${t.storeName}\n${t.storeDescription}`, null, out);
  for (const i of t.items) scan(`${i.storeItemName}\n${i.storeItemDescription}`, i.storeItemId, out);

  // Many items, every one at the same price: a hint of a fake catalogue (not on its own a flag).
  if (t.items.length >= 8) {
    const prices = new Set(t.items.map((i) => JSON.stringify(i.storeItemPrices ?? {})));
    if (prices.size === 1) out.hints.push({ itemId: null, code: "PHANTOM_PRODUCT", evidence: `all ${t.items.length} items have the same price` });
  }
  return out;
}
