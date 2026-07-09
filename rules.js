export function symbolFor(coin) {
  // Asume pares contra USDT, el estándar en Binance para casi todo
  return `${coin.toUpperCase()}USDT`;
}

function describeType(rule) {
  const labels = {
    above: `sube por encima de $${rule.value}`,
    below: `baja por debajo de $${rule.value}`,
    change_up: `sube ${rule.value}% o más en 24h`,
    change_down: `baja ${rule.value}% o más en 24h`,
  };
  return labels[rule.type] || rule.type;
}

// Evalúa una regla contra el ticker actual. Devuelve null si no se cumple,
// o un objeto con el mensaje (y la orden sugerida, si la regla la define).
export function evaluateRule(rule, ticker, holdingAmount) {
  let hit = false;
  if (rule.type === 'above') hit = ticker.price > rule.value;
  if (rule.type === 'below') hit = ticker.price < rule.value;
  if (rule.type === 'change_up') hit = ticker.changePercent >= rule.value;
  if (rule.type === 'change_down') hit = ticker.changePercent <= -Math.abs(rule.value);
  if (!hit) return null;

  const result = {
    coin: rule.coin,
    message: `${rule.coin} ${describeType(rule)} — precio actual $${ticker.price.toFixed(2)} (24h ${ticker.changePercent.toFixed(2)}%)`,
  };

  if (rule.order) {
    let qty = 0;
    if (rule.order.sizeType === 'usd') qty = rule.order.sizeValue / ticker.price;
    if (rule.order.sizeType === 'qty') qty = rule.order.sizeValue;
    if (rule.order.sizeType === 'pct_holding') qty = holdingAmount * (rule.order.sizeValue / 100);
    result.order = {
      side: rule.order.side,
      symbol: symbolFor(rule.coin),
      quantity: qty,
      referencePrice: ticker.price,
      approxValueUSD: qty * ticker.price,
    };
  }
  return result;
}
