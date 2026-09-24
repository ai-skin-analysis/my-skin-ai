(() => {
  const formatDate = (value) => {
    if (!value) return 'ยังไม่มีบันทึกการเข้าใช้';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'ยังไม่มีบันทึกการเข้าใช้';
    return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };

  const setText = (id, value) => { document.getElementById(id).textContent = String(value); };

  function setActionStatus(message, tone = 'success') {
    const target = document.getElementById('adminActionStatus');
    target.className = tone === 'error'
      ? 'rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700'
      : 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-semibold text-emerald-700';
    target.textContent = message;
    target.classList.remove('hidden');
  }

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
      cell.colSpan = 6;
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
      const pending = user.approvalStatus === 'pending';
      badge.className = pending
        ? 'rounded-full border border-amber-200 bg-amber-50 px-3 py-1 font-mono text-[10px] font-bold text-amber-700'
        : 'rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-[10px] font-bold text-emerald-700';
      badge.textContent = pending ? 'PENDING APPROVAL' : 'APPROVED';
      status.appendChild(badge);
      row.appendChild(status);
      const action = document.createElement('td');
      action.className = 'p-4';
      if (pending) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rounded-xl bg-teal-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-teal-700 disabled:cursor-wait disabled:opacity-60';
        button.textContent = 'ยืนยันบัญชี';
        button.addEventListener('click', () => approveUser(user.id, button));
        action.appendChild(button);
      } else {
        const approved = document.createElement('span');
        approved.className = 'text-[11px] font-semibold text-slate-400';
        approved.textContent = 'อนุมัติแล้ว';
        action.appendChild(approved);
      }
      row.appendChild(action);
      target.appendChild(row);
    });
  }

  async function approveUser(userId, button) {
    const initialLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'กำลังยืนยัน…';
    try {
      const response = await fetch('/api/admin/approve-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ userId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || 'ไม่สามารถยืนยันบัญชีได้');
      setActionStatus(`ยืนยันบัญชี ${data.user.name} เรียบร้อยแล้ว`);
      await loadAdmin();
    } catch (error) {
      setActionStatus(error.message || 'ไม่สามารถยืนยันบัญชีได้', 'error');
      button.disabled = false;
      button.textContent = initialLabel;
    }
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
      setText('pendingUserCount', data.counts.pendingUsers);
      setText('approvedUserCount', data.counts.users);
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
