(() => {
  let enrollmentId = '';

  function showStatus(message, type = 'info') {
    const element = document.getElementById('mfaStatus');
    if (!element) return;
    element.textContent = message;
    element.className = `mt-5 rounded-xl px-4 py-3 text-sm ${type === 'error' ? 'bg-rose-950/70 text-rose-100 border border-rose-800' : 'bg-teal-500/10 text-teal-100 border border-teal-500/30'}`;
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'ไม่สามารถดำเนินการได้ในขณะนี้');
    return data;
  }

  async function verifyEnrollmentSession() {
    const response = await fetch('/api/account/me', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    const user = data.user;
    if (!response.ok || !user || user.role !== 'admin') return window.location.replace('/');
    if (user.mfaEnrolled && user.mfaVerified) return window.location.replace('/admin.html');
    if (user.mfaEnrolled) return window.location.replace('/');
  }

  async function startEnrollment() {
    const button = document.getElementById('startMfaButton');
    button.disabled = true;
    button.textContent = 'กำลังสร้างคีย์…';
    try {
      const data = await request('/api/admin/mfa/enroll');
      enrollmentId = data.enrollment.enrollmentId;
      document.getElementById('mfaSecret').textContent = data.enrollment.secret;
      document.getElementById('mfaStartPanel').classList.add('hidden');
      document.getElementById('mfaConfirmForm').classList.remove('hidden');
      document.getElementById('mfaCode').focus();
      showStatus('เพิ่มคีย์ในแอป Authenticator แล้วกรอกรหัสที่แสดงในแอป');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'เริ่มตั้งค่า MFA';
      showStatus(error.message, 'error');
    }
  }

  async function confirmEnrollment(event) {
    event.preventDefault();
    const button = document.getElementById('confirmMfaButton');
    button.disabled = true;
    button.textContent = 'กำลังยืนยัน…';
    try {
      await request('/api/admin/mfa/confirm', { enrollmentId, code: document.getElementById('mfaCode').value });
      window.location.replace('/admin.html');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'ยืนยันและเข้าสู่แดชบอร์ด';
      showStatus(error.message, 'error');
    }
  }

  async function copySecret() {
    const value = document.getElementById('mfaSecret').textContent;
    try { await navigator.clipboard.writeText(value); showStatus('คัดลอกคีย์แล้ว — เก็บเป็นความลับ'); }
    catch { showStatus('ไม่สามารถคัดลอกอัตโนมัติ กรุณาคัดลอกคีย์ด้วยตนเอง', 'error'); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('startMfaButton').addEventListener('click', startEnrollment);
    document.getElementById('mfaConfirmForm').addEventListener('submit', confirmEnrollment);
    document.getElementById('copyMfaSecret').addEventListener('click', copySecret);
    verifyEnrollmentSession();
  });
})();
