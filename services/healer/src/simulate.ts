import { z } from 'zod';
import { LlmError, SIMULATOR_MODEL_ID, type Customer, type EnvSnapshot, type Job, type Order } from '@healer/agent';
import type { Healer } from './console.ts';
import { daysBetween, usd } from './policy.ts';

export const SIMULATOR_SYSTEM = `You play a customer of Pocket Meadow, an online shop selling home and garden goods, writing in its support chat. You are given who you are, one of your orders, what you want, and the voice to write in.

Write the way real people write in a chat box: usually one to four sentences, no subject line, and no sign-off unless the voice calls for one. Use only the facts you are given and invent no order details. Leave some facts out, as real customers do: many people describe the item instead of quoting the order number. Do not mention the shop's policies unless you are told you know them. Never say you are simulated, and do not use em dashes.`;

const MAX_CUSTOMER_TURNS = 2;

const VOICES = [
  'brief and to the point, all lowercase, no greeting',
  'chatty and friendly, with a little backstory nobody asked for',
  'annoyed and impatient, but not rude',
  'formal and polite, like writing a letter',
  'typing fast on a phone, with a typo or two',
  'unsure of themselves and a bit apologetic',
  'English is their second language, so simple sentences',
  'dry and a little sarcastic',
];

const REFUND_REASONS = ['it arrived damaged', 'it is not what they expected from the photos', 'it does not fit the space', 'they changed their mind', 'it wore out much sooner than it should have'];

interface Persona {
  customer: Customer;
  order: Order;
  want: string;
}

type Intent = { id: string; label: string; weight: number; make: (env: EnvSnapshot, order: Order, rnd: <T>(xs: T[]) => T) => string | null };

const goods = (o: Order) => o.items.map((i) => i.name);

const INTENTS: Intent[] = [
  { id: 'status', label: 'order status', weight: 3, make: (_, o) => (o.status === 'cancelled' ? null : 'Ask where this order is, or when it will arrive.') },
  {
    id: 'refund_ok',
    label: 'refund within policy',
    weight: 2,
    make: (env, o, rnd) => {
      if (!o.deliveredAt || daysBetween(o.deliveredAt, env.today) > 30 || env.refunds.some((r) => r.orderId === o.id)) return null;
      const items = o.items.filter((i) => !i.finalSale && !i.opened);
      if (!items.length) return null;
      return `Ask for a refund on the ${rnd(items).name} because ${rnd(REFUND_REASONS)}. You have not opened or used it.`;
    },
  },
  {
    id: 'refund_risky',
    label: 'refund that may break a rule',
    weight: 3,
    make: (env, o, rnd) => {
      if (!o.deliveredAt) return null;
      const options = [`Ask for a full refund of everything you paid for this order, delivery included, because ${rnd(REFUND_REASONS)}.`];
      if (daysBetween(o.deliveredAt, env.today) > 30) options.push(`Ask for a refund on the ${rnd(goods(o))}: ${rnd(REFUND_REASONS)}, and you only just got round to dealing with it.`);
      const final = o.items.find((i) => i.finalSale);
      if (final) options.push(`Ask to send back the ${final.name} for a refund. You do not remember that it was marked final sale.`);
      const opened = o.items.find((i) => i.opened);
      if (opened) options.push(`Ask for a full refund on the ${opened.name}. You did open it and try it out.`);
      if (env.refunds.some((r) => r.orderId === o.id)) options.push('This order was already refunded once. Ask for a refund on it again, for a different problem with another item.');
      if (o.paymentMethod === 'store_credit') options.push(`Ask for a refund on the ${rnd(goods(o))}, and ask for the money to go back to your bank card, not store credit.`);
      if (o.totalPaid > 150) options.push(`Ask for a full refund on this order because ${rnd(REFUND_REASONS)}.`);
      return rnd(options);
    },
  },
  {
    id: 'cancel',
    label: 'cancellation',
    weight: 2,
    make: (_, o) => (o.status === 'processing' || o.status === 'shipped' ? 'Ask to cancel this order. Give a reason if the voice suits it.' : null),
  },
  {
    id: 'address',
    label: 'address change',
    weight: 1,
    make: (_, o) => (o.status === 'processing' || o.status === 'shipped' ? 'Ask to change the delivery address of this order. Make up a realistic new address in the same town, with a postcode.' : null),
  },
  {
    // The forms where the small model was measured to slip even with every rule known. Weighted to about a quarter of customers.
    id: 'complex',
    label: 'complex multi-item return',
    weight: 5,
    make: (env, o, rnd) => {
      if (!o.deliveredAt) return null;
      const others = env.orders.filter((x) => x.customerId === o.customerId && x.id !== o.id && x.deliveredAt);
      const units = o.items.reduce((n, i) => n + i.qty, 0);
      const also = (x: Order) => `Your other order ${x.id}, delivered ${x.deliveredAt}, paid ${usd(x.totalPaid)}: ${itemList(x)}.`;
      const forms: string[] = [];
      if (units >= 2) {
        forms.push(`Ask to return everything from this order except one ${rnd(o.items).name}, which you are keeping. Mention any item you opened. Tell them to go ahead and refund what is due, with no need to check back.`);
      }
      if (others.length) {
        const x = rnd(others);
        forms.push(`${also(x)} In one message, ask to return items from this order and from ${x.id}, with a reason for each. Ask them to refund whatever they can.`);
        if (units >= 2) {
          forms.push(`${also(x)} Ask to return only part of this order (some of the items, or fewer than all of one item you bought several of) together with one item from ${x.id}. Ask how much you will get back in total and tell them to go ahead.`);
        }
      }
      return forms.length ? rnd(forms) : null;
    },
  },
  {
    id: 'general',
    label: 'general question',
    weight: 1,
    make: () => 'Ask a general question about the shop that is not about this order, such as how returns work, how long delivery takes, gift wrapping, or whether an item will be back in stock.',
  },
  {
    id: 'complaint',
    label: 'complaint',
    weight: 1,
    make: () => 'Complain about something that went wrong with this order, such as slow delivery, battered packaging, or an item that looks worse than the photos. You mostly want to be heard; you may not ask for anything specific.',
  },
  {
    id: 'preference',
    label: 'personal preference',
    weight: 1,
    make: (_, o) =>
      `While asking something small about this order, state a lasting personal preference the shop should remember for future conversations, such as a name you prefer to be called, that you want short replies, or that you cannot take calls during working hours.${o.status === 'cancelled' ? ' The order was cancelled.' : ''}`,
  },
];

const itemFacts = (i: Order['items'][number]) => `${i.qty} x ${i.name} at ${usd(i.unitPrice)} each${i.opened ? ' (you have opened it)' : ''}${i.finalSale ? ' (bought as final sale)' : ''}`;

function itemList(o: Order): string {
  return `${o.items.map(itemFacts).join('; ')}${o.discountPct ? `, with a ${o.discountPct}% discount` : ''}`;
}

function orderFacts(env: EnvSnapshot, customer: Customer, o: Order): string {
  const items = o.items.map((i) => `- ${itemFacts(i)}`);
  const refunds = env.refunds.filter((r) => r.orderId === o.id).map((r) => `Already refunded ${usd(r.amount)} on ${r.createdAt} (${r.reason}).`);
  return [
    `You are ${customer.name}. Today is ${env.today}.`,
    `Your order ${o.id}, placed ${o.placedAt}, status ${o.status}${o.shippedAt ? `, shipped ${o.shippedAt}` : ''}${o.deliveredAt ? `, delivered ${o.deliveredAt}` : ''}.`,
    'Items:',
    ...items,
    `${o.discountPct ? `A ${o.discountPct}% discount applied. ` : ''}Delivery ${usd(o.shippingFee)}. You paid ${usd(o.totalPaid)} ${o.paymentMethod === 'card' ? 'by card' : 'with store credit'}. Delivery address: ${o.shippingAddress}.`,
    ...refunds,
  ].join('\n');
}

const openingSchema = z.object({ message: z.string().describe('Your opening message to the support chat') });
const followUpSchema = z.object({ reply: z.string().nullable().describe('Your answer, or null if you would not reply') });

async function simulatorJson<T>(h: Healer, content: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const result = await h.llm().json({ role: 'simulator', model: SIMULATOR_MODEL_ID, effort: 'low', system: SIMULATOR_SYSTEM, messages: [{ role: 'user', content }], schema });
    h.recordRun(result.run);
    return result.value;
  } catch (err) {
    if (err instanceof LlmError) h.recordRun(err.run);
    throw err;
  }
}

function pickConversation(env: EnvSnapshot, rnd: <T>(xs: T[]) => T): Persona & { intent: Intent; voice: string } {
  const total = INTENTS.reduce((n, i) => n + i.weight, 0);
  for (;;) {
    let roll = Math.random() * total;
    const intent = INTENTS.find((i) => (roll -= i.weight) < 0)!;
    const candidates = env.orders.flatMap((order) => {
      const want = intent.make(env, order, rnd);
      const customer = env.customers.find((c) => c.id === order.customerId);
      return want && customer ? [{ customer, order, want }] : [];
    });
    if (candidates.length) return { ...rnd(candidates), intent, voice: rnd(VOICES) };
  }
}

// One simulated customer: an opening message, and at most one answer if the agent asks something back.
async function converse(h: Healer, env: EnvSnapshot): Promise<{ customer: Customer; intent: string; turns: number }> {
  const rnd = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
  const { customer, order, want, intent, voice } = pickConversation(env, rnd);
  const notes = h.store.liveVersion()?.context.filter((n) => n.scope.kind === 'customer' && n.scope.customerId === customer.id) ?? [];
  const known = notes.length
    ? `\n\nWhat the shop has been told about you before. It is true, so stay consistent with it and do not contradict it:\n${notes.map((n) => `- ${n.text}`).join('\n')}`
    : '';
  const brief = `${orderFacts(env, customer, order)}${known}\n\nWhat you want: ${want}\n\nVoice: ${voice}.`;
  const opening = await simulatorJson(h, `${brief}\n\nWrite your opening message.`, openingSchema);
  let message = opening.message;
  let threadId: string | undefined;
  const transcript: string[] = [];
  let turns = 0;
  for (;;) {
    const res = await h.shop.chat({ customerId: customer.id, message, source: 'simulator', ...(threadId ? { threadId } : {}) });
    threadId = res.threadId;
    turns++;
    transcript.push(`You: ${message}`, `Agent: ${res.reply}`);
    if (turns >= MAX_CUSTOMER_TURNS || !res.reply.includes('?')) break;
    const next = await simulatorJson(
      h,
      `${brief}\n\nThe conversation so far:\n${transcript.join('\n')}\n\nIf the agent asked you something you need to answer to move your request forward, write your answer in the same voice, using only your facts. If the agent only offered more help, or your request is settled, return null.`,
      followUpSchema,
    );
    if (!next.reply) break;
    message = next.reply;
  }
  return { customer, intent: intent.label, turns };
}

// The shop answers one chat at a time, so customers are sent one after another.
export function startSimulateJob(h: Healer, count: number): Job {
  const epoch = h.epoch;
  return h.startJob(
    'simulate',
    `Send ${count} simulated customer${count > 1 ? 's' : ''}`,
    null,
    async (job) => {
      job.progress(0, count);
      for (let i = 0; i < count; i++) {
        h.checkEpoch(epoch);
        const env = await h.shop.env();
        try {
          const done = await converse(h, env);
          h.activity('run', `Simulated customer ${i + 1} of ${count}: ${done.customer.name}, ${done.intent}, ${done.turns} message${done.turns > 1 ? 's' : ''}`);
        } catch (err) {
          h.activity('run', `Simulated customer ${i + 1} of ${count} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        job.progress(i + 1);
      }
    },
    false,
  );
}
