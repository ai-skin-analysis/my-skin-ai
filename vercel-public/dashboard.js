(() => {
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
    let previewUrl = '';
    let cameraStream = null;

    function refreshIcons() {
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function setStatus(message, tone = 'info') {
        const status = document.getElementById('dashboardImageStatus');
        if (!status) return;
        const tones = {
            info: 'mt-3 text-xs leading-relaxed text-amber-900',
            success: 'mt-3 text-xs font-semibold leading-relaxed text-teal-800',
            error: 'mt-3 text-xs font-semibold leading-relaxed text-rose-700',
        };
        status.className = tones[tone] || tones.info;
        status.textContent = message;
    }

    function formatSize(bytes) {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function isAllowedImage(file) {
        if (!file || !IMAGE_TYPES.has(file.type)) {
            setStatus('กรุณาเลือกภาพ JPG, JPEG, PNG หรือ WEBP เท่านั้น', 'error');
            return false;
        }
        if (!file.size || file.size > MAX_IMAGE_BYTES) {
            setStatus('ภาพต้องมีขนาดไม่เกิน 8 MB กรุณาเลือกไฟล์ที่เล็กลง', 'error');
            return false;
        }
        return true;
    }

    function presentImage(file, source) {
        if (!isAllowedImage(file)) return;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(file);
        document.getElementById('dashboardImagePreview').src = previewUrl;
        document.getElementById('dashboardImageMeta').textContent = `${source}: ${file.name} · ${formatSize(file.size)}`;
        document.getElementById('dashboardImagePlaceholder').classList.add('hidden');
        document.getElementById('dashboardImagePreviewPanel').classList.remove('hidden');
        setStatus('ภาพพร้อมสำหรับดูตัวอย่างบนอุปกรณ์นี้เท่านั้น ภาพไม่ได้ถูกอัปโหลด จัดเก็บ หรือส่งให้ผู้ดูแลระบบ', 'success');
    }

    function clearImage() {
        const input = document.getElementById('dashboardImageInput');
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        if (input) input.value = '';
        document.getElementById('dashboardImagePreview').removeAttribute('src');
        document.getElementById('dashboardImagePlaceholder').classList.remove('hidden');
        document.getElementById('dashboardImagePreviewPanel').classList.add('hidden');
        setStatus('ล้างภาพจากหน้าปัจจุบันแล้ว ไม่มีภาพถูกเก็บหรือส่งออกจากอุปกรณ์', 'info');
    }

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach((track) => track.stop());
            cameraStream = null;
        }
        const video = document.getElementById('dashboardCameraStream');
        if (video) video.srcObject = null;
    }

    function closeCamera() {
        stopCamera();
        const modal = document.getElementById('dashboardCameraModal');
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.setAttribute('aria-hidden', 'true');
    }

    async function openCamera() {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            setStatus('ไม่สามารถใช้กล้องได้ โปรดเปิดผ่าน HTTPS บนอุปกรณ์ที่รองรับกล้อง', 'error');
            return;
        }
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            const video = document.getElementById('dashboardCameraStream');
            video.srcObject = cameraStream;
            const modal = document.getElementById('dashboardCameraModal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            modal.setAttribute('aria-hidden', 'false');
            document.getElementById('dashboardTakePhotoButton').focus();
        } catch (error) {
            stopCamera();
            setStatus('ไม่สามารถเปิดกล้องได้ โปรดอนุญาตการใช้กล้องในเบราว์เซอร์ แล้วลองใหม่อีกครั้ง', 'error');
        }
    }

    function takePhoto() {
        const video = document.getElementById('dashboardCameraStream');
        const canvas = document.getElementById('dashboardCameraCanvas');
        if (!video.videoWidth || !video.videoHeight) {
            setStatus('กล้องยังไม่พร้อมถ่ายภาพ โปรดลองอีกครั้ง', 'error');
            return;
        }
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
            if (!blob) {
                setStatus('ไม่สามารถสร้างภาพจากกล้องได้ โปรดลองใหม่อีกครั้ง', 'error');
                return;
            }
            const photo = new File([blob], `skin-photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
            const input = document.getElementById('dashboardImageInput');
            if (typeof DataTransfer !== 'undefined') {
                const transfer = new DataTransfer();
                transfer.items.add(photo);
                input.files = transfer.files;
            }
            presentImage(photo, 'ถ่ายจากกล้อง');
            closeCamera();
        }, 'image/jpeg', 0.92);
    }

    async function requireSession() {
        try {
            const response = await fetch('/api/account/me', { credentials: 'same-origin' });
            const data = await response.json();
            if (!response.ok || !data.user) throw new Error('missing session');
            if (data.user.role === 'admin') {
                document.getElementById('dashboardAdminLink').classList.remove('hidden');
                document.getElementById('dashboardHomeLink').classList.add('hidden');
            } else {
                document.getElementById('dashboardUserName').textContent = data.user.name;
                document.getElementById('dashboardUserName').classList.remove('hidden');
            }
            document.getElementById('dashboardLoading').classList.add('hidden');
            document.getElementById('dashboardMain').classList.remove('hidden');
        } catch (error) {
            window.location.replace('/');
        }
    }

    function openLogoutModal() {
        const modal = document.getElementById('dashboardLogoutModal');
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.setAttribute('aria-hidden', 'false');
        document.getElementById('dashboardLogoutConfirmButton').focus();
    }

    function closeLogoutModal() {
        const modal = document.getElementById('dashboardLogoutModal');
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.setAttribute('aria-hidden', 'true');
        document.getElementById('dashboardLogoutButton').focus();
    }

    async function logout() {
        const button = document.getElementById('dashboardLogoutConfirmButton');
        button.disabled = true;
        button.textContent = 'กำลังออกจากระบบ…';
        try {
            await fetch('/api/account/logout', { method: 'POST', credentials: 'same-origin' });
        } finally {
            window.location.replace('/');
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        refreshIcons();
        document.getElementById('dashboardImageInput').addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (file) presentImage(file, 'เลือกจากอุปกรณ์');
        });
        document.getElementById('dashboardOpenCameraButton').addEventListener('click', openCamera);
        document.getElementById('dashboardClearImageButton').addEventListener('click', clearImage);
        document.getElementById('dashboardCloseCameraButton').addEventListener('click', closeCamera);
        document.getElementById('dashboardCancelCameraButton').addEventListener('click', closeCamera);
        document.getElementById('dashboardTakePhotoButton').addEventListener('click', takePhoto);
        document.getElementById('dashboardLogoutButton').addEventListener('click', openLogoutModal);
        document.getElementById('dashboardLogoutCancelButton').addEventListener('click', closeLogoutModal);
        document.getElementById('dashboardLogoutConfirmButton').addEventListener('click', logout);
        document.getElementById('dashboardLogoutModal').addEventListener('click', (event) => {
            if (event.target === event.currentTarget) closeLogoutModal();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !document.getElementById('dashboardLogoutModal').classList.contains('hidden')) closeLogoutModal();
        });
        window.addEventListener('pagehide', stopCamera);
        requireSession();
    });
})();
