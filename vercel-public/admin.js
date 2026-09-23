(() => {
  async function logout() {
    const button = document.getElementById('adminLogoutButton');
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
      document.getElementById('adminName').textContent = data.admin.name;
      document.getElementById('adminEmail').textContent = data.admin.email;
      document.getElementById('accountCount').textContent = String(data.counts.accounts);
      document.getElementById('adminCount').textContent = String(data.counts.admins);
      document.getElementById('adminLoading').classList.add('hidden');
      document.getElementById('adminMain').classList.remove('hidden');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch {
      window.location.replace('/');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('adminLogoutButton').addEventListener('click', logout);
    loadAdmin();
  });
})();
