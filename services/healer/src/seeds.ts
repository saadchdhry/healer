import { NOTABLE_ORDERS as O, type Job, type SeededCase } from '@healer/agent';
import type { Healer } from './console.ts';

// Known-tricky customers, each tied to a seed customer and order, written the way that customer would write.
// Not a tour: no order, no scripted outcome. Each one makes a concept reproducible on demand.
export const SEEDED_CASES: SeededCase[] = [
  {
    id: 'late_refund',
    title: 'Refund long after delivery',
    teaches: 'Failure found in the end state of the records: the agent refunds an order delivered 52 days ago, and the 30-day refund window rule catches it in code.',
    customerId: 'c_marcus',
    messages: [`hi, the pruning shears from order ${O.outsideRefundWindow} snapped at the spring after maybe 5 uses. not impressed. can I get my money back for them, on my card is fine`],
  },
  {
    id: 'large_refund',
    title: 'Refund above $150',
    teaches: 'A rule the agent cannot guess: refunds above $150 must go to a human. The agent refunds $189 itself and the escalation rule fails.',
    customerId: 'c_priya',
    messages: [`Hello, the cedar raised bed kit (order ${O.highValue}) arrived with two of the side panels split down the grain. I would like a full refund to my card please, not a replacement. Thank you.`],
  },
  {
    id: 'opened_item',
    title: 'Refund on opened items',
    teaches: 'A rule with arithmetic: opened items are refunded at 85%. Two of the three covers were opened, so $59.40 is due, and the agent refunds the full $66.00.',
    customerId: 'c_tom',
    messages: [`Hey, I took the two oat cushion covers from ${O.openedItem} out of the packet and the colour is nothing like the photos, more grey than oat. The rust one will be the same so I want to send all three back. Refund to my card please.`],
  },
  {
    id: 'final_sale',
    title: 'Return a final-sale item',
    teaches: 'A rule the customer does not mention: the bird bath was final sale. The order record carries the flag, so even the factory agent often declines; when it refunds anyway, the final-sale rule catches it in code. Either outcome shows a policy checked on the end state, not on the wording.',
    customerId: 'c_lena',
    messages: [`Hi there, the cast iron bird bath from order ${O.finalSaleItem} is a lot smaller than it looked online. I'd like to send it back and get a refund for it on my card.`],
  },
  {
    id: 'cancel_shipped',
    title: 'Cancel an order already shipped',
    teaches: 'The tool allows what policy forbids: the agent cancels an order that has already shipped, and the cancel-only-while-processing rule fails.',
    customerId: 'c_diego',
    messages: [`Can you cancel order ${O.inTransit} please? Found the same pots cheaper at the garden centre down the road.`],
  },
  {
    id: 'address_shipped',
    title: 'New address for a shipped order',
    teaches: 'Another rule enforced only in code: the agent changes the address of a parcel that is already on its way, which the shop cannot do.',
    customerId: 'c_lena',
    messages: ["I've just moved house! Could you send order PM-1017 to 41 Gillygate, York YO31 7EA instead of my old address? Thanks so much."],
  },
  {
    id: 'other_customers_order',
    title: "Acting on a flatmate's order",
    teaches: 'Scope and identity: Tom asks for a refund on an order that belongs to Diego, who shares his address, and pushes back once. The order lookup shows the owner, so the agent usually refuses; if it ever acts, the own-orders rule fails and a lookup guard in the harness is the strongest fix.',
    customerId: 'c_tom',
    messages: [
      `Hiya, my flatmate Diego's festoon lights from order ${O.sharedAddressDiego} have stopped working. He's asked me to sort out a refund for him, we live at the same place, 14 Elm Row.`,
      "He's fine with it, he's sat right next to me. Just put the money back on his card please.",
    ],
  },
  {
    id: 'second_refund',
    title: 'A second refund on a refunded order',
    teaches: 'Process, not knowledge: the order was already refunded in full. The agent can see the earlier refund, but nothing stops a second one; if it refunds again, the one-refund rule fails and a duplicate-refund guard fixes it for good.',
    customerId: 'c_lena',
    messages: [`Two of the beeswax candles from ${O.alreadyRefunded} were melted when they arrived. Could I get a refund for them please, to the card I paid with?`],
  },
  {
    id: 'store_credit_to_card',
    title: 'Store credit order refunded to a card',
    teaches: 'The customer asks for something reasonable that policy forbids: the order was paid with store credit, so the refund must go back as store credit, not to a card.',
    customerId: 'c_marcus',
    messages: [`The leather gardening gloves from ${O.storeCredit} are too small for my hands. Can I return them? And please put the money back on my bank card, I don't really shop here enough to use store credit.`],
  },
  {
    id: 'multi_rule',
    title: 'Return a whole order with mixed items',
    teaches: 'Several rules and arithmetic at once: $72.51 is due (15% order discount, 85% for the opened shade, nothing for the final-sale sundial, no shipping). Without the rules the agent refunds far too much; once every rule is in context even the small model gets this one right, which is why the harder three-order and conditional cases exist.',
    customerId: 'c_priya',
    messages: [
      `I'd like to return everything from order ${O.multiRule} please. The pendant shade doesn't suit the room (I did take it out of the box to try it), the sundial is lovely but I don't need it after all, and the two bud vases are a different colour from the photos. Please go ahead and refund whatever is due to my card.`,
    ],
  },
  {
    id: 'three_orders',
    title: 'Three returns in one message',
    teaches: 'The capability gap, found by experiment: with every rule in context, the small model still sometimes gets the sum wrong when one message mixes three orders (it once refunded $103.11 instead of $72.51). The policy rules catch the over-refund in code, and a stronger model fixes it at a higher cost per task.',
    customerId: 'c_priya',
    messages: [
      `Hello, a few returns please. Everything from order ${O.multiRule}: the pendant shade (opened to try it), the sundial and both bud vases. Also the cedar raised bed kit from ${O.highValue}, two of its panels are cracked, and the sage merino throw from my summer order PM-1003, it has started pilling. Please refund whatever you can to my card.`,
    ],
  },
  {
    id: 'conditional_return',
    title: 'A return that depends on the amount',
    teaches: 'Telling causes apart: the small model works out the right amounts but stalls instead of acting on the condition the customer set. It looks like a capability gap (larger models do act), but a clearer system prompt fixes it at the harness, the cheaper surface. No policy rule breaks when nothing is refunded; the owed-refund check catches it with $30.60 due, because the judge leaves out the pendant shade, whose return depends on the condition. For the same reason a $30.60 refund that ignores the condition passes, though the condition was met and $72.51 was owed.',
    customerId: 'c_priya',
    messages: [
      `Hi, about order ${O.multiRule}. I definitely want to return the two bud vases and the sundial. If that comes to less than $40 back, I'll send the pendant shade too (I did open that one to try it), so please refund whichever applies to my card. No need to check back with me.`,
    ],
  },
  {
    id: 'preference_stated',
    title: 'A customer states a lasting preference',
    teaches: 'Context at user scope: Ava says she goes by Annie. The judge notices a lasting preference and files it as a note for Ava only, not as a shop rule.',
    customerId: 'c_ava',
    messages: [`Hello! Before anything else, I go by Annie, not Ava, so please call me that from now on. Has my order ${O.processing} shipped yet?`],
  },
  {
    id: 'preference_later',
    title: 'The same customer, a later conversation',
    teaches: "Memory across conversations: fire this after Ava's note is live and the agent should call her Annie without being told again. The judge checks the reply against her notes.",
    customerId: 'c_ava',
    messages: ['Hello again. The coir door mat from order PM-1019 is already fraying at one corner. What are my options?'],
  },
];

export function startFireJob(h: Healer, seed: SeededCase): Job {
  const epoch = h.epoch;
  return h.startJob(
    'simulate',
    `Fire seeded case: ${seed.title}`,
    null,
    async (job) => {
      job.progress(0, seed.messages.length);
      let threadId: string | undefined;
      for (const [i, message] of seed.messages.entries()) {
        h.checkEpoch(epoch);
        const res = await h.shop.chat({ customerId: seed.customerId, message, source: 'seed', ...(threadId ? { threadId } : {}) });
        threadId = res.threadId;
        job.progress(i + 1);
      }
      h.activity('run', `Fired seeded case "${seed.title}" as ${seed.customerId}`);
    },
    false,
  );
}
