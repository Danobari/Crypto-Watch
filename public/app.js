document.addEventListener('DOMContentLoaded', () => {
  // Navigation & UI Elements
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.content-section');
  const sectionTitle = document.getElementById('section-title');
  const refreshBtn = document.getElementById('refresh-btn');
  const addRuleBtn = document.getElementById('add-rule-btn');
  
  // Modal Elements
  const ruleModal = document.getElementById('rule-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const ruleForm = document.getElementById('rule-form');

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

  // Modal Logic
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

  // Data Loading
  async function loadData(tab) {
    if (tab === 'overview') await loadBalances();
    else if (tab === 'market') await loadMarket();
    else if (tab === 'rules') await loadRules();
    else if (tab === 'alerts') await loadAlerts();
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
  loadData('overview');
});
