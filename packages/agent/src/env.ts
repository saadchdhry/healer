import type { Customer, EnvSnapshot, Escalation, Order, OrderItem, Refund } from './types.ts';

export const SHOP_NAME = 'Pocket Meadow';
export const SEED_TODAY = '2026-11-11';

export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function orderTotal(items: OrderItem[], discountPct: number, shippingFee: number): number {
  const goods = items.reduce((sum, i) => sum + i.qty * i.unitPrice * (1 - discountPct / 100), 0);
  return roundCents(goods + shippingFee);
}

export class Environment {
  private state: EnvSnapshot;

  constructor(snapshot: EnvSnapshot) {
    this.state = structuredClone(snapshot);
  }

  snapshot(): EnvSnapshot {
    return structuredClone(this.state);
  }

  get today(): string {
    return this.state.today;
  }

  customers(): Customer[] {
    return structuredClone(this.state.customers);
  }

  customer(id: string): Customer | null {
    const c = this.state.customers.find((x) => x.id === id);
    return c ? structuredClone(c) : null;
  }

  ordersFor(customerId: string): Order[] {
    return structuredClone(this.state.orders.filter((o) => o.customerId === customerId));
  }

  order(id: string): Order | null {
    const o = this.findOrder(id);
    return o ? structuredClone(o) : null;
  }

  refundsFor(orderId: string): Refund[] {
    return structuredClone(this.state.refunds.filter((r) => r.orderId === orderId));
  }

  addRefund(orderId: string, amount: number, method: Refund['method'], reason: string): Refund {
    const refund: Refund = {
      id: `RF-${String(this.state.refunds.length + 1).padStart(4, '0')}`,
      orderId,
      amount: roundCents(amount),
      method,
      reason,
      createdAt: this.state.today,
    };
    this.state.refunds.push(refund);
    return structuredClone(refund);
  }

  cancelOrder(orderId: string): Order {
    const o = this.mustFindOrder(orderId);
    o.status = 'cancelled';
    return structuredClone(o);
  }

  setShippingAddress(orderId: string, address: string): Order {
    const o = this.mustFindOrder(orderId);
    o.shippingAddress = address;
    return structuredClone(o);
  }

  addEscalation(customerId: string, orderId: string | null, reason: string): Escalation {
    const escalation: Escalation = {
      id: `ESC-${String(this.state.escalations.length + 1).padStart(4, '0')}`,
      customerId,
      orderId,
      reason,
      createdAt: this.state.today,
    };
    this.state.escalations.push(escalation);
    return structuredClone(escalation);
  }

  private findOrder(id: string): Order | undefined {
    return this.state.orders.find((o) => o.id === id);
  }

  private mustFindOrder(id: string): Order {
    const o = this.findOrder(id);
    if (!o) throw new Error(`Unknown order ${id}`);
    return o;
  }
}

export const NOTABLE_ORDERS = {
  cleanRefund: 'PM-1004',
  outsideRefundWindow: 'PM-1002',
  highValue: 'PM-1007',
  openedItem: 'PM-1009',
  finalSaleItem: 'PM-1011',
  inTransit: 'PM-1013',
  processing: 'PM-1015',
  storeCredit: 'PM-1016',
  alreadyRefunded: 'PM-1006',
  multiRule: 'PM-1018',
  sharedAddressTom: 'PM-1010',
  sharedAddressDiego: 'PM-1014',
} as const;

const customers: Customer[] = [
  { id: 'c_ava', name: 'Ava Thompson', email: 'ava.thompson@example.com', memberSince: '2023-04-12' },
  { id: 'c_marcus', name: 'Marcus Bell', email: 'marcus.bell@example.com', memberSince: '2024-01-30' },
  { id: 'c_priya', name: 'Priya Nair', email: 'priya.nair@example.com', memberSince: '2022-09-05' },
  { id: 'c_tom', name: 'Tom Okafor', email: 'tom.okafor@example.com', memberSince: '2025-03-18' },
  { id: 'c_lena', name: 'Lena Fischer', email: 'lena.fischer@example.com', memberSince: '2024-06-22' },
  { id: 'c_diego', name: 'Diego Ramirez', email: 'diego.ramirez@example.com', memberSince: '2025-08-02' },
];

const ADDRESS = {
  ava: '27 Willow Lane, Bristol BS6 5TJ',
  marcus: '9 Harbour Street, Leith, Edinburgh EH6 6QD',
  priya: '112 Orchard Road, Cambridge CB1 3HF',
  sharedTomDiego: '14 Elm Row, Flat 2, Manchester M14 6LT',
  lena: '3 Mill Court, York YO1 7HB',
};

function item(sku: string, name: string, qty: number, unitPrice: number, flags: { opened?: boolean; finalSale?: boolean } = {}): OrderItem {
  return { sku, name, qty, unitPrice, opened: flags.opened ?? false, finalSale: flags.finalSale ?? false };
}

type OrderSeed = Omit<Order, 'totalPaid' | 'discountPct' | 'shippingFee' | 'paymentMethod'> &
  Partial<Pick<Order, 'discountPct' | 'shippingFee' | 'paymentMethod'>>;

function order(seed: OrderSeed): Order {
  const discountPct = seed.discountPct ?? 0;
  const shippingFee = seed.shippingFee ?? 4.95;
  return {
    ...seed,
    discountPct,
    shippingFee,
    paymentMethod: seed.paymentMethod ?? 'card',
    totalPaid: orderTotal(seed.items, discountPct, shippingFee),
  };
}

const orders: Order[] = [
  order({
    id: 'PM-1001', customerId: 'c_ava', status: 'delivered',
    items: [item('SC-STN-4', 'Stoneware mug set (4)', 1, 34), item('KT-OLV-1', 'Olive wood serving board', 1, 28.5)],
    placedAt: '2026-08-09', shippedAt: '2026-08-11', deliveredAt: '2026-08-14', shippingAddress: ADDRESS.ava,
  }),
  order({
    id: 'PM-1002', customerId: 'c_marcus', status: 'delivered',
    items: [item('GD-SHR-1', 'Bypass pruning shears', 1, 24), item('GD-KNL-1', 'Foam garden kneeler', 2, 12.5)],
    placedAt: '2026-09-14', shippedAt: '2026-09-16', deliveredAt: '2026-09-20', shippingAddress: ADDRESS.marcus,
  }),
  order({
    id: 'PM-1003', customerId: 'c_priya', status: 'delivered',
    items: [item('HM-THR-1', 'Merino wool throw, sage', 1, 79)],
    placedAt: '2026-07-24', shippedAt: '2026-07-26', deliveredAt: '2026-07-30', shippingAddress: ADDRESS.priya, shippingFee: 0,
  }),
  order({
    id: 'PM-1004', customerId: 'c_ava', status: 'delivered',
    items: [item('GD-CAN-1', 'Brass watering can, 1.5 L', 1, 42), item('GD-MST-1', 'Copper plant mister', 1, 18)],
    placedAt: '2026-10-27', shippedAt: '2026-10-29', deliveredAt: '2026-11-01', shippingAddress: ADDRESS.ava,
  }),
  order({
    id: 'PM-1005', customerId: 'c_tom', status: 'cancelled',
    items: [item('HM-BSK-2', 'Rattan storage basket, large', 1, 36)],
    placedAt: '2026-10-02', shippedAt: null, deliveredAt: null, shippingAddress: ADDRESS.sharedTomDiego,
  }),
  order({
    id: 'PM-1006', customerId: 'c_lena', status: 'delivered',
    items: [item('HM-CND-3', 'Beeswax pillar candles (3)', 2, 16)],
    placedAt: '2026-10-12', shippedAt: '2026-10-14', deliveredAt: '2026-10-17', shippingAddress: ADDRESS.lena,
  }),
  order({
    id: 'PM-1007', customerId: 'c_priya', status: 'delivered',
    items: [item('GD-BED-1', 'Cedar raised garden bed kit', 1, 189)],
    placedAt: '2026-10-28', shippedAt: '2026-10-30', deliveredAt: '2026-11-03', shippingAddress: ADDRESS.priya, shippingFee: 0,
  }),
  order({
    id: 'PM-1008', customerId: 'c_diego', status: 'delivered',
    items: [item('GD-TRL-1', 'Bamboo trellis panel', 2, 14.5), item('GD-TWN-1', 'Jute garden twine', 3, 3.75)],
    placedAt: '2026-09-08', shippedAt: '2026-09-10', deliveredAt: '2026-09-15', shippingAddress: ADDRESS.sharedTomDiego,
  }),
  order({
    id: 'PM-1009', customerId: 'c_tom', status: 'delivered',
    items: [item('HM-CSH-1', 'Linen cushion cover, oat', 2, 22, { opened: true }), item('HM-CSH-2', 'Linen cushion cover, rust', 1, 22)],
    placedAt: '2026-10-22', shippedAt: '2026-10-24', deliveredAt: '2026-10-28', shippingAddress: ADDRESS.sharedTomDiego,
  }),
  order({
    id: 'PM-1010', customerId: 'c_tom', status: 'delivered',
    items: [item('OD-LGT-1', 'Outdoor festoon string lights, 10 m', 1, 39)],
    placedAt: '2026-10-25', shippedAt: '2026-10-27', deliveredAt: '2026-10-31', shippingAddress: ADDRESS.sharedTomDiego,
  }),
  order({
    id: 'PM-1011', customerId: 'c_lena', status: 'delivered',
    items: [item('GD-BTH-1', 'Cast iron bird bath', 1, 64, { finalSale: true }), item('GD-SED-1', 'Kitchen herb seed kit', 1, 15)],
    placedAt: '2026-10-24', shippedAt: '2026-10-26', deliveredAt: '2026-10-30', shippingAddress: ADDRESS.lena, shippingFee: 6.95,
  }),
  order({
    id: 'PM-1012', customerId: 'c_marcus', status: 'delivered',
    items: [item('HM-PLN-1', 'Speckled ceramic planter, medium', 2, 26)],
    placedAt: '2026-10-19', shippedAt: '2026-10-21', deliveredAt: '2026-10-25', shippingAddress: ADDRESS.marcus,
  }),
  order({
    id: 'PM-1013', customerId: 'c_diego', status: 'shipped',
    items: [item('GD-POT-5', 'Terracotta pot set (5)', 1, 32), item('HM-MAC-1', 'Macrame hanging planter', 1, 19)],
    placedAt: '2026-11-06', shippedAt: '2026-11-09', deliveredAt: null, shippingAddress: ADDRESS.sharedTomDiego,
  }),
  order({
    id: 'PM-1014', customerId: 'c_diego', status: 'delivered',
    items: [item('OD-LGT-1', 'Outdoor festoon string lights, 10 m', 1, 39), item('OD-PEG-1', 'Light hanging hooks (10)', 1, 8)],
    placedAt: '2026-10-29', shippedAt: '2026-10-31', deliveredAt: '2026-11-04', shippingAddress: ADDRESS.sharedTomDiego,
  }),
  order({
    id: 'PM-1015', customerId: 'c_ava', status: 'processing',
    items: [item('HM-THR-2', 'Merino wool throw, ochre', 1, 79), item('HM-CND-1', 'Beeswax taper candles (6)', 1, 14)],
    placedAt: '2026-11-10', shippedAt: null, deliveredAt: null, shippingAddress: ADDRESS.ava, shippingFee: 0,
  }),
  order({
    id: 'PM-1016', customerId: 'c_marcus', status: 'delivered',
    items: [item('GD-GLV-1', 'Leather gardening gloves', 1, 21), item('GD-SED-1', 'Kitchen herb seed kit', 1, 15)],
    placedAt: '2026-10-28', shippedAt: '2026-10-30', deliveredAt: '2026-11-02', shippingAddress: ADDRESS.marcus, paymentMethod: 'store_credit',
  }),
  order({
    id: 'PM-1017', customerId: 'c_lena', status: 'shipped',
    items: [item('HM-BSK-1', 'Rattan storage basket, small', 2, 24)],
    placedAt: '2026-11-05', shippedAt: '2026-11-08', deliveredAt: null, shippingAddress: ADDRESS.lena,
  }),
  order({
    id: 'PM-1018', customerId: 'c_priya', status: 'delivered', discountPct: 15,
    items: [
      item('HM-LMP-1', 'Woven rattan pendant shade', 1, 58, { opened: true }),
      item('GD-SUN-1', 'Brass sundial', 1, 45, { finalSale: true }),
      item('HM-VAS-1', 'Hand-thrown bud vase', 2, 18),
    ],
    placedAt: '2026-10-30', shippedAt: '2026-11-01', deliveredAt: '2026-11-05', shippingAddress: ADDRESS.priya,
  }),
  order({
    id: 'PM-1019', customerId: 'c_ava', status: 'delivered',
    items: [item('GD-MAT-1', 'Coir door mat, botanical', 1, 27)],
    placedAt: '2026-10-16', shippedAt: '2026-10-18', deliveredAt: '2026-10-22', shippingAddress: ADDRESS.ava,
  }),
  order({
    id: 'PM-1020', customerId: 'c_marcus', status: 'processing',
    items: [item('OD-CHR-1', 'Folding acacia garden chair', 2, 55)],
    placedAt: '2026-11-11', shippedAt: null, deliveredAt: null, shippingAddress: ADDRESS.marcus, shippingFee: 0,
  }),
];

const refundedOrder = orders.find((o) => o.id === NOTABLE_ORDERS.alreadyRefunded)!;

export function seedSnapshot(): EnvSnapshot {
  return structuredClone({
    today: SEED_TODAY,
    customers,
    orders,
    refunds: [
      {
        id: 'RF-0001',
        orderId: refundedOrder.id,
        amount: refundedOrder.totalPaid,
        method: 'original_payment' as const,
        reason: 'Candles arrived melted',
        createdAt: '2026-10-20',
      },
    ],
    escalations: [],
  });
}
