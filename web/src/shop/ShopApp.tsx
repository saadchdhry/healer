import { useEffect, useRef, useState } from 'react';
import type { Customer, Order, Rating } from '@healer/agent';
import { call, isMissingKey } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { date, money } from '../lib/format.ts';
import './shop.css';

const CUSTOMER_KEY = 'pm.customer';

function readStored(): string | null {
  try {
    return localStorage.getItem(CUSTOMER_KEY);
  } catch {
    return null;
  }
}

export function ShopApp() {
  const customers = useApi('GET /api/shop/customers', []);
  const [customerId, setCustomerId] = useState<string | null>(readStored);

  useEffect(() => {
    document.title = 'Pocket Meadow';
  }, []);

  const list = customers.data ?? [];
  const current = list.find((c) => c.id === customerId) ?? list[0];

  function pick(id: string) {
    setCustomerId(id);
    try {
      localStorage.setItem(CUSTOMER_KEY, id);
    } catch {
      // Private windows can refuse storage; the choice simply is not remembered.
    }
  }

  return (
    <div className="pm">
      <header className="pm-top">
        <a className="pm-mark" href="/">
          <Sprig />
          <span>Pocket Meadow</span>
        </a>
        <p className="pm-tag">Home and garden goods, grown slowly</p>
        {current && (
          <label className="pm-who">
            <span>Shopping as</span>
            <select value={current.id} onChange={(e) => pick(e.target.value)}>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {customers.error ? (
        <div className="pm-shell">
          <p className="pm-calm">The shop is not answering right now. Check that the shop service is running, then reload this page.</p>
        </div>
      ) : !current ? (
        <div className="pm-shell">
          <p className="pm-calm">{customers.loading ? 'Opening the shop…' : 'There are no customers in the shop yet.'}</p>
        </div>
      ) : (
        <main className="pm-shell pm-grid" key={current.id}>
          <Orders customer={current} />
          <Chat customer={current} />
        </main>
      )}
    </div>
  );
}

function Sprig() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <path d="M16 29V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M16 18c-6 0-9-4-9-9 5 0 9 3 9 9Z" fill="var(--pm-leaf)" />
      <path d="M16 14c5 0 8-3 8-8-5 0-8 3-8 8Z" fill="var(--pm-leaf-2)" />
      <circle cx="16" cy="6" r="2.4" fill="var(--pm-sun)" />
    </svg>
  );
}

const steps: Order['status'][] = ['processing', 'shipped', 'delivered'];
const statusText: Record<Order['status'], string> = { processing: 'Being packed', shipped: 'On its way', delivered: 'Delivered', cancelled: 'Cancelled' };

function Orders({ customer }: { customer: Customer }) {
  const orders = useApi('GET /api/shop/customers/:id/orders', [{ params: { id: customer.id } }]);
  const first = customer.name.split(' ')[0];
  return (
    <section className="pm-orders" aria-labelledby="pm-orders-h">
      <h1 id="pm-orders-h">Hello, {first}</h1>
      <p className="pm-sub">
        Member since {date(customer.memberSince)}. Here is everything you have ordered from us.
      </p>
      {orders.error ? (
        <p className="pm-calm">We could not load your orders just now. Try again in a moment.</p>
      ) : orders.loading ? (
        <p className="pm-calm">Fetching your orders…</p>
      ) : !orders.data?.length ? (
        <p className="pm-calm">No orders yet. When you buy something it will appear here.</p>
      ) : (
        <ol className="pm-order-list">
          {orders.data
            .slice()
            .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
            .map((o) => (
              <OrderCard key={o.id} order={o} />
            ))}
        </ol>
      )}
    </section>
  );
}

function OrderCard({ order }: { order: Order }) {
  const reached = steps.indexOf(order.status);
  const when =
    order.status === 'delivered' && order.deliveredAt
      ? `Delivered ${date(order.deliveredAt)}`
      : order.status === 'shipped' && order.shippedAt
        ? `Shipped ${date(order.shippedAt)}`
        : order.status === 'cancelled'
          ? 'This order was cancelled'
          : `Placed ${date(order.placedAt)}`;
  return (
    <li className={`pm-order is-${order.status}`}>
      <div className="pm-order-head">
        <div>
          <p className="pm-order-no">Order {order.id.replace(/^ord_/, '#')}</p>
          <p className="pm-order-when">{when}</p>
        </div>
        <span className="pm-status">{statusText[order.status]}</span>
      </div>
      {order.status !== 'cancelled' && (
        <div className="pm-track" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s} className={i <= reached ? 'on' : ''} />
          ))}
        </div>
      )}
      <ul className="pm-items">
        {order.items.map((i) => (
          <li key={i.sku}>
            <span className="pm-qty">{i.qty}×</span>
            <span className="pm-item-name">
              {i.name}
              {i.finalSale && <em className="pm-flag">Final sale</em>}
            </span>
            <span className="pm-price">{money(i.qty * i.unitPrice)}</span>
          </li>
        ))}
      </ul>
      <div className="pm-order-foot">
        <span>
          {order.discountPct > 0 && `${order.discountPct}% off. `}
          {order.shippingFee > 0 ? `Delivery ${money(order.shippingFee)}` : 'Free delivery'}
          {`. Paid by ${order.paymentMethod === 'card' ? 'card' : 'store credit'}`}
        </span>
        <strong>{money(order.totalPaid)}</strong>
      </div>
    </li>
  );
}

interface Turn {
  role: 'customer' | 'agent';
  text: string;
  traceId: string | null;
  rating: Rating | null;
}

function Chat({ customer }: { customer: Customer }) {
  const [threadId, setThreadId] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<'offline' | 'failed' | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const threads = useApi('GET /api/shop/customers/:id/threads', [{ params: { id: customer.id } }]);

  useEffect(() => {
    const latest = threads.data?.at(-1);
    if (!latest) return;
    setThreadId(latest.id);
    setTurns(latest.turns.map((t) => ({ role: t.role, text: t.text, traceId: t.traceId, rating: t.rating })));
  }, [threads.data]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, pending]);

  async function send(e: { preventDefault(): void }) {
    e.preventDefault();
    const message = draft.trim();
    if (!message || pending) return;
    setDraft('');
    setProblem(null);
    setTurns((t) => [...t, { role: 'customer', text: message, traceId: null, rating: null }]);
    setPending(true);
    try {
      const res = await call('POST /api/shop/chat', { body: { customerId: customer.id, threadId, message } });
      setThreadId(res.threadId);
      setTurns((t) => [...t, { role: 'agent', text: res.reply, traceId: res.traceId, rating: null }]);
    } catch (err) {
      setProblem(isMissingKey(err) ? 'offline' : 'failed');
    } finally {
      setPending(false);
    }
  }

  async function rate(index: number, rating: Rating) {
    const turn = turns[index];
    if (!turn?.traceId) return;
    setTurns((t) => t.map((x, i) => (i === index ? { ...x, rating } : x)));
    try {
      await call('POST /api/shop/feedback', { body: { traceId: turn.traceId, rating } });
    } catch {
      setTurns((t) => t.map((x, i) => (i === index ? { ...x, rating: turn.rating } : x)));
    }
  }

  function restart() {
    setThreadId(undefined);
    setTurns([]);
    setProblem(null);
  }

  return (
    <section className="pm-chat" aria-labelledby="pm-chat-h">
      <div className="pm-chat-head">
        <div>
          <h2 id="pm-chat-h">Ask us anything</h2>
          <p>Returns, refunds, deliveries, changes to an order.</p>
        </div>
        <button type="button" className="pm-ghost" onClick={restart} disabled={pending || turns.length === 0}>
          New conversation
        </button>
      </div>
      <div className="pm-log" ref={logRef} aria-live="polite">
        {turns.length === 0 && !pending && (
          <p className="pm-hello">
            Hi {customer.name.split(' ')[0]}. Tell us what you need help with and we will sort it out. We can see your orders, so
            there is no need to look up numbers.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`pm-bubble ${t.role}`}>
            <p>{t.text}</p>
            {t.role === 'agent' && t.traceId && (
              <div className="pm-rate" role="group" aria-label="Was this helpful?">
                <button type="button" aria-pressed={t.rating === 'up'} aria-label="Helpful" onClick={() => rate(i, 'up')}>
                  <Thumb />
                </button>
                <button type="button" aria-pressed={t.rating === 'down'} aria-label="Not helpful" onClick={() => rate(i, 'down')}>
                  <Thumb down />
                </button>
                {t.rating && <span>Thanks for letting us know</span>}
              </div>
            )}
          </div>
        ))}
        {pending && (
          <div className="pm-bubble agent pm-typing" aria-label="Writing a reply">
            <span />
            <span />
            <span />
          </div>
        )}
        {problem === 'offline' && (
          <p className="pm-note">
            Our assistant is offline at the moment. It comes back once an API key is added to the <code>.env</code> file.
          </p>
        )}
        {problem === 'failed' && <p className="pm-note">That message did not go through. Please try sending it again.</p>}
      </div>
      <form className="pm-compose" onSubmit={send}>
        <label className="pm-sr" htmlFor="pm-msg">
          Your message
        </label>
        <textarea
          id="pm-msg"
          rows={2}
          value={draft}
          placeholder="Write a message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) void send(e);
          }}
        />
        <button type="submit" className="pm-send" disabled={pending || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

function Thumb({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path
        d="M6 9v8H3V9h3Zm2 8h6.6a2 2 0 0 0 2-1.6l1-5A2 2 0 0 0 15.6 8H12l.6-3.2A1.6 1.6 0 0 0 11 3L8 8.6V17Z"
        fill="currentColor"
      />
    </svg>
  );
}
