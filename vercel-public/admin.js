(() => {
  const formatDate = (value) => {
    if (!value) return 'ยังไม่มีบันทึกการเข้าใช้';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'ยังไม่มีบันทึกการเข้าใช้';
    return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };

  const setText = (id, value) => { document.getElementById(id).textContent = String(value); };

  function appendCell(row, value, className = '') {
    const cell = document.createElement('td');
    cell.className = `p-4 ${className}`.trim();
    cell.textContent = value;
    row.appendChild(cell);
  }

  function renderUsers(users) {
    const target = document.getElementById('usersTable');
    target.replaceChildren();
    if (!users.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'p-8 text-center font-mono text-slate-400';
      cell.textContent = 'NO_USER_RECORDS_FOUND';
      row.appendChild(cell);
      target.appendChild(row);
      return;
    }
    users.forEach((user) => {
      const row = document.createElement('tr');
      row.className = 'transition-colors hover:bg-slate-50/80';
      appendCell(row, `#${user.id}`, 'font-mono font-bold text-teal-700');
      appendCell(row, user.name, 'font-bold text-slate-900');
      appendCell(row, user.email, 'font-mono text-slate-600');
      appendCell(row, formatDate(user.lastLoginAt), 'font-mono text-[11px] text-slate-500');
      const status = document.createElement('td');
      status.className = 'p-4';
      const badge = document.createElement('span');
      badge.className = 'rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-[10px] font-bold text-emerald-700';
      badge.textContent = 'ACTIVE';
      status.appendChild(badge);
      row.appendChild(status);
      target.appendChild(row);
    });
  }

  function openLogoutModal() {
    const modal = document.getElementById('adminLogoutModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('adminLogoutConfirmButton').focus();
  }

  function closeLogoutModal() {
    const modal = document.getElementById('adminLogoutModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.setAttribute('aria-hidden', 'true');
    document.getElementById('adminLogoutButton').focus();
  }

  async function logout() {
    const button = document.getElementById('adminLogoutConfirmButton');
    button.disabled = true;
    button.textContent = 'กำลังออกจากระบบ…';
    try { await fetch('/api/account/logout', { method: 'POST', credentials: 'same-origin' }); }
    finally { window.location.replace('/'); }
  }

  async function loadAdmin() {
    try {
      const response = await fetch('/api/admin/overview', { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.code === 'mfa_enrollment_required') return window.location.replace('/admin-mfa-enroll.html');
        throw new Error('not-admin');
      }
      setText('adminName', data.admin.name);
      setText('userCount', data.counts.users);
      setText('adminCount', data.counts.admins);
      setText('scanCount', data.counts.scans);
      setText('radarAccountCount', `${data.counts.users} ACTIVE`);
      setText('radarUserText', data.counts.users ? `ผู้ใช้ทั่วไป ${data.counts.users} บัญชีในระบบ` : 'ยังไม่มีผู้ใช้ทั่วไปในระบบขณะนี้');
      setText('latestScanResult', 'ยังไม่มีข้อมูล');
      setText('latestScanConfidence', '0.0%');
      setText('feedbackCount', '0 ข้อความ');
      renderUsers(data.users || []);
      document.getElementById('adminLoading').classList.add('hidden');
      document.getElementById('adminMain').classList.remove('hidden');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch {
      window.location.replace('/');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('adminLogoutButton').addEventListener('click', openLogoutModal);
    document.getElementById('adminLogoutCancelButton').addEventListener('click', closeLogoutModal);
    document.getElementById('adminLogoutConfirmButton').addEventListener('click', logout);
    document.getElementById('adminLogoutModal').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeLogoutModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !document.getElementById('adminLogoutModal').classList.contains('hidden')) closeLogoutModal();
    });
    loadAdmin();
  });
})();
