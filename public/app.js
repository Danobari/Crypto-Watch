document.addEventListener('DOMContentLoaded', () => {
  // Navigation & UI Elements
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.content-section');
  const sectionTitle = document.getElementById('section-title');
  const refreshBtn = document.getElementById('refresh-btn');
  const addRuleBtn = document.getElementById('add-rule-btn');

  // Modal Elements (Reglas)
  const ruleModal = document.getElementById('rule-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const ruleForm = document.getElementById('rule-form');

  // Modal Elements (Preparar Orden)
  const orderModal = document.getElementById('order-modal');
  const closeOrderModalBtn = document.getElementById('close-order-modal');

  // Switch Tabs
  function switchTab(tabId) {
    navItems.forEach(item => {
      item.classList.remove('active');
      if (item.id === `nav-${tabId}`) {
        item.classList.add('active');
        sectionTitle.textContent = item.textContent.trim();
      }
    });

    sections.forEach(sec => {
      sec.classList.remove('active');
      if (sec.id === `${tabId}-section`) {
        sec.classList.add('active');
      }
    });

    addRuleBtn.style.display = tabId === 'rules' ? 'flex' : 'none';
    loadData(tabId);
  }

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.id.replace('nav-', '');
      switchTab(tabId);
    });
  });

  refreshBtn.addEventListener('click', () => {
    const activeTab = document.querySelector('.nav-item.active').id.replace('nav-', '');
    loadData(activeTab);
  });

  // Modal Logic (Reglas)
  addRuleBtn.addEventListener('click', () => {
    ruleModal.classList.add('active');
  });

  closeModalBtn.addEventListener('click', () => {
    ruleModal.classList.remove('active');
    ruleForm.reset();
  });

  ruleModal.addEventListener('click', (e) => {
    if (e.target === ruleModal) {
      ruleModal.classList.remove('active');
      ruleForm.reset();
    }
  });

  ruleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newRule = {
      coin: document.getElementById('rule-coin').value.toUpperCase(),
      type: document.getElementById('rule-type').value,
      value: parseFloat(document.getElementById('rule-value').value),
      order: {
        side: document.getElementById('rule-side').value,
        sizeType: document.getElementById('rule-sizeType').value,
        sizeValue: parseFloat(document.getElementById('rule-sizeValue').value)
      }
    };

    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRule)
      });
      if (res.ok) {
        ruleModal.classList.remove('active');
        ruleForm.reset();
        loadRules();
      }
    } catch (err) {
      alert('Error al guardar regla: ' + err.message);
    }
  });

  window.deleteRule = async function(id) {
    if (!confirm('¿Seguro que deseas eliminar esta regla?')) return;
    try {
      const res = await fetch(`/api/rules/${id}`, { method: 'DELETE' });
      if (res.ok) loadRules();
    } catch (e) {
      alert('Error al eliminar');
    }
  };

  // Modal Logic (Preparar Orden)
  closeOrderModalBtn.addEventListener('click', () => orderModal.classList.remove('active'));
  orderModal.addEventListener('click', (e) => {
    if (e.target === orderModal) orderModal.classList.remove('active');
  });

  window.openOrderModal = async function (coin, levelIndex, levelPct) {
    orderModal.classList.add('active');
    document.getElementById('order-modal-title').textContent = `${coin} — Nivel +${levelPct}%`;
    const body = document.getElementById('order-modal-body');
    const footer = document.getElementById('order-modal-footer');
    body.innerHTML = 'Calculando orden...';
    footer.innerHTML = '';

    try {
      const res = await fetch(`/api/portfolio/${coin}/order/${levelIndex}`);
      const order = await res.json();
      if (order.error) { body.innerHTML = `<span style="color: var(--danger-color)">${order.error}</span>`; return; }

      if (order.quantity === 0 || order.level.sellPct === 0) {
        body.innerHTML = `
          <p style="margin-bottom:1rem;">${order.level.action || 'Este nivel no vende automáticamente. Evalúa el contexto del mercado.'}</p>
        `;
      } else {
        body.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:0.75rem;">
            <div><span style="color:var(--text-secondary)">Lado:</span> <strong>VENTA</strong></div>
            <div><span style="color:var(--text-secondary)">Símbolo:</span> <strong>${order.symbol}</strong></div>
            <div><span style="color:var(--text-secondary)">Cantidad sugerida:</span>
              <strong id="order-qty">${order.quantity.toFixed(6)}</strong> ${coin}
            </div>
            <div><span style="color:var(--text-secondary)">Precio referencia:</span> $${order.referencePrice.toFixed(4)}</div>
            <div><span style="color:var(--text-secondary)">Valor aproximado:</span> $${order.approxValueUSD.toFixed(2)}</div>
            <div style="color:var(--text-secondary); font-size:0.875rem;">Reserva sugerida para impuestos (30%, orientativo — confirma con tu contador): ~$${order.taxReserveSugerida.toFixed(2)}</div>
            <div style="font-size:0.875rem; color:var(--text-secondary); margin-top:0.5rem;">Tú decides si la colocas y a qué precio — esto no ejecuta nada en Binance.</div>
          </div>
        `;
        footer.innerHTML = `
          <button class="btn glass-panel" id="copy-qty-btn">Copiar cantidad</button>
          <a class="btn btn-primary" href="${order.binanceLink}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Abrir en Binance</a>
          <button class="btn glass-panel" id="mark-sold-btn">Marcar como vendido</button>
        `;
        document.getElementById('copy-qty-btn').addEventListener('click', () => {
          navigator.clipboard.writeText(order.quantity.toFixed(6));
          document.getElementById('copy-qty-btn').textContent = 'Copiado ✓';
        });
        document.getElementById('mark-sold-btn').addEventListener('click', async () => {
          await fetch(`/api/positions/${coin}/levels/${levelIndex}/mark-sold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sold: true })
          });
          orderModal.classList.remove('active');
          loadPortfolio();
        });
      }
    } catch (e) {
      body.innerHTML = `<span style="color: var(--danger-color)">Error de conexión</span>`;
    }
  };

  // Data Loading
  async function loadData(tab) {
    if (tab === 'portfolio') await loadPortfolio();
    else if (tab === 'overview') await loadBalances();
    else if (tab === 'market') await loadMarket();
    else if (tab === 'cycle') await loadCycle();
    else if (tab === 'rules') await loadRules();
    else if (tab === 'alerts') await loadAlerts();
  }

  async function loadPortfolio() {
    const tbody = document.getElementById('portfolio-tbody');
    tbody.innerHTML = '<tr><td colspan="10" class="text-center">Cargando cartera...</td></tr>';
    try {
      const res = await fetch('/api/portfolio');
      const data = await res.json();
      if (data.error) return tbody.innerHTML = `<tr><td colspan="10" style="color: var(--danger-color)">Error: ${data.error}</td></tr>`;
      if (data.length === 0) return tbody.innerHTML = '<tr><td colspan="10" class="text-center">Sin posiciones en data/positions.json</td></tr>';

      const blockLabels = { core: 'Core', rotation: 'Rotación', experimental: 'Experimental' };

      tbody.innerHTML = data.map(p => {
        const changeColor = p.changePct === null ? 'var(--text-secondary)' : (p.changePct >= 0 ? 'var(--success-color)' : 'var(--danger-color)');
        const changeTxt = p.changePct === null ? '—' : `${p.changePct >= 0 ? '+' : ''}${p.changePct.toFixed(1)}%`;
        const actionBtn = p.nivelCruzadoPendiente
          ? `<button class="btn btn-primary" style="padding:0.4rem 0.9rem; font-size:0.8rem;" onclick="openOrderModal('${p.coin}', ${p.nivelCruzadoPendiente.levelIndex}, ${p.nivelCruzadoPendiente.pct})">Preparar Orden</button>`
          : (p.pendienteInfo
              ? `<button class="btn glass-panel" style="padding:0.4rem 0.9rem; font-size:0.8rem;" onclick="openOrderModal('${p.coin}', ${p.levels.findIndex(l => l.pct === p.pendienteInfo.pct)}, ${p.pendienteInfo.pct})">Ver nivel +${p.pendienteInfo.pct}%</button>`
              : '<span class="badge inactive">Completo</span>');

        return `
          <tr>
            <td><strong>${p.coin}</strong>${p.notes ? `<div style="font-size:0.75rem; color:var(--text-secondary); max-width:220px;">${p.notes}</div>` : ''}</td>
            <td><span class="badge active">${blockLabels[p.block] || p.block}</span></td>
            <td>${p.holdingAmount.toFixed(6)}</td>
            <td>$${p.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}</td>
            <td>${p.currentPrice !== null ? '$' + p.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'}</td>
            <td style="color:${changeColor}; font-weight:600;">${changeTxt}</td>
            <td>${p.valorActual !== null ? '$' + p.valorActual.toFixed(2) : '—'}</td>
            <td>${p.pctVendido}%</td>
            <td style="font-size:0.85rem;">${p.proximaAccion}</td>
            <td>${actionBtn}</td>
          </tr>
        `;
      }).join('');
    } catch (e) { tbody.innerHTML = `<tr><td colspan="10" style="color: var(--danger-color)">Error de conexión</td></tr>`; }
  }

  async function loadBalances() {
    const grid = document.getElementById('balances-grid');
    grid.innerHTML = '<div class="loading-state">Cargando saldos...</div>';
    try {
      const res = await fetch('/api/balances');
      const data = await res.json();
      if (data.error) return grid.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error: ${data.error}</div>`;
      if (data.length === 0) return grid.innerHTML = '<div class="loading-state">No hay saldos disponibles.</div>';

      grid.innerHTML = data.map(b => `
        <div class="crypto-card glass-panel">
          <div class="card-header">
            <span class="crypto-symbol">${b.asset}</span>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          </div>
          <div class="crypto-amount">${b.free.toFixed(6)}</div>
          <div class="crypto-value">Bloqueado: ${b.locked.toFixed(6)}</div>
        </div>
      `).join('');
    } catch (e) { grid.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error de conexión</div>`; }
  }

  async function loadMarket() {
    const grid = document.getElementById('market-grid');
    grid.innerHTML = '<div class="loading-state">Consultando el mercado en tiempo real...</div>';
    try {
      const res = await fetch('/api/market');
      const data = await res.json();
      if (data.error) return grid.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error: ${data.error}</div>`;
      if (data.length === 0) return grid.innerHTML = '<div class="loading-state">Sin datos de mercado.</div>';

      grid.innerHTML = data.map(m => {
        const isUp = m.changePercent >= 0;
        const trendClass = isUp ? 'trend-up' : 'trend-down';
        const trendIcon = isUp ? '↑' : '↓';
        return `
          <div class="crypto-card glass-panel ${trendClass}">
            <div class="card-header">
              <span class="crypto-symbol">${m.coin}</span>
              <span class="trend-badge">${trendIcon} ${Math.abs(m.changePercent).toFixed(2)}%</span>
            </div>
            <div class="crypto-amount">$${parseFloat(m.price).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 6})}</div>
            <div class="crypto-value">Precio 24h</div>
          </div>
        `;
      }).join('');
    } catch (e) { grid.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error de conexión</div>`; }
  }

  async function loadCycle() {
    const grid = document.getElementById('cycle-grid');
    grid.innerHTML = '<div class="loading-state">Consultando ciclo de mercado...</div>';
    try {
      const res = await fetch('/api/cycle');
      const data = await res.json();
      if (data.error) return grid.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error: ${data.error}</div>`;

      grid.innerHTML = `
        <div class="crypto-card glass-panel">
          <div class="card-header"><span class="crypto-symbol">Dominancia BTC</span></div>
          <div class="crypto-amount">${data.btcDominance !== null ? data.btcDominance.toFixed(1) + '%' : '—'}</div>
          <div class="crypto-value">% del market cap total en BTC</div>
        </div>
        <div class="crypto-card glass-panel">
          <div class="card-header"><span class="crypto-symbol">Ratio ETH/BTC</span></div>
          <div class="crypto-amount">${data.ethBtcRatio !== null ? data.ethBtcRatio.toFixed(5) : '—'}</div>
          <div class="crypto-value">BTC 24h: ${data.btcChange24h !== null ? data.btcChange24h.toFixed(2) + '%' : '—'} · ETH 24h: ${data.ethChange24h !== null ? data.ethChange24h.toFixed(2) + '%' : '—'}</div>
        </div>
        <div class="crypto-card glass-panel" style="grid-column: 1 / -1;">
          <div class="card-header"><span class="crypto-symbol">Lectura rápida</span></div>
          <div class="crypto-value" style="font-size:1rem; margin-top:0.5rem;">${data.signal}</div>
          <div style="margin-top:1rem;"><a href="${data.altseasonIndexLink}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-color);">Ver índice completo de Altseason →</a></div>
        </div>
      `;
    } catch (e) { grid.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error de conexión</div>`; }
  }

  async function loadRules() {
    const tbody = document.querySelector('#rules-table tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center">Cargando reglas...</td></tr>';
    try {
      const res = await fetch('/api/rules');
      const data = await res.json();
      if (data.length === 0) return tbody.innerHTML = '<tr><td colspan="5" class="text-center">No hay reglas configuradas.</td></tr>';

      tbody.innerHTML = data.map(r => `
        <tr>
          <td><strong>${r.coin}</strong></td>
          <td>${r.type} ${r.value}</td>
          <td>${r.order ? r.order.side.toUpperCase() : 'Notificar'}</td>
          <td><span class="badge active">Activa</span></td>
          <td><button class="btn btn-danger" onclick="deleteRule('${r.id}')">Eliminar</button></td>
        </tr>
      `).join('');
    } catch (e) { tbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger-color)">Error de conexión</td></tr>`; }
  }

  async function loadAlerts() {
    const list = document.getElementById('alerts-list');
    list.innerHTML = '<div class="loading-state">Cargando alertas...</div>';
    try {
      const res = await fetch('/api/alerts');
      const data = await res.json();
      if (data.length === 0) return list.innerHTML = '<div class="loading-state">No hay alertas en el registro.</div>';

      list.innerHTML = data.map(a => `
        <div class="alert-item glass-panel">
          <div class="alert-time">${new Date(a.time).toLocaleString()}</div>
          <div class="alert-msg">${a.message}</div>
        </div>
      `).join('');
    } catch (e) { list.innerHTML = `<div class="loading-state" style="color: var(--danger-color)">Error de conexión</div>`; }
  }

  // Init
  loadData('portfolio');
});
