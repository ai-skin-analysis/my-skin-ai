(() => {
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const MAX_AVATAR_INPUT_BYTES = 2 * 1024 * 1024;
    const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
    let previewUrl = '';
    let cameraStream = null;
    let currentUser = null;
    let savedAvatarDataUrl = null;
    let pendingAvatarDataUrl = null;

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

    function setModalStatus(id, message, tone = 'info') {
        const element = document.getElementById(id);
        if (!element) return;
        element.className = `mt-3 text-xs leading-relaxed ${tone === 'error' ? 'text-rose-700' : tone === 'success' ? 'font-semibold text-teal-700' : 'text-slate-500'}`;
        element.textContent = message;
    }

    function formatSize(bytes) {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'ไม่ทราบเวลา' : new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }

    function initialForUser() {
        return Array.from(currentUser?.name || 'U')[0]?.toUpperCase() || 'U';
    }

    function applyAvatar(dataUrl) {
        savedAvatarDataUrl = dataUrl || null;
        const headerImage = document.getElementById('userProfileAvatarImage');
        const headerInitial = document.getElementById('userAvatarInitial');
        const modalImage = document.getElementById('profileAvatarPreview');
        const modalInitial = document.getElementById('profileAvatarInitial');
        [headerImage, modalImage].forEach((image) => {
            if (!image) return;
            if (dataUrl) {
                image.src = dataUrl;
                image.classList.remove('hidden');
            } else {
                image.removeAttribute('src');
                image.classList.add('hidden');
            }
        });
        [headerInitial, modalInitial].forEach((element) => {
            if (!element) return;
            element.textContent = initialForUser();
            element.classList.toggle('hidden', Boolean(dataUrl));
        });
    }

    function showModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        closeUserMenu();
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.setAttribute('aria-hidden', 'false');
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.setAttribute('aria-hidden', 'true');
    }

    function closeAllAccountModals() {
        ['profileAvatarModal', 'userTimelineModal', 'nearbyRadarModal', 'accountInfoModal', 'changePasswordModal', 'feedbackModal', 'deleteAccountModal'].forEach(closeModal);
    }

    async function userRequest(path, options = {}) {
        const requestOptions = { credentials: 'same-origin', ...options };
        if (options.body) requestOptions.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const response = await fetch(path, requestOptions);
        let data;
        try { data = await response.json(); } catch { data = {}; }
        if (!response.ok || !data.ok) throw new Error(data.message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง');
        return data;
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
        closeModal('dashboardCameraModal');
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
            document.getElementById('dashboardCameraStream').srcObject = cameraStream;
            showModal('dashboardCameraModal');
            document.getElementById('dashboardTakePhotoButton').focus();
        } catch {
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

    function openUserMenu() {
        const menu = document.getElementById('userAccountMenu');
        const button = document.getElementById('userAccountButton');
        if (!menu || !button) return;
        const willOpen = menu.classList.contains('hidden');
        menu.classList.toggle('hidden', !willOpen);
        button.setAttribute('aria-expanded', String(willOpen));
    }

    function closeUserMenu() {
        const menu = document.getElementById('userAccountMenu');
        const button = document.getElementById('userAccountButton');
        if (menu) menu.classList.add('hidden');
        if (button) button.setAttribute('aria-expanded', 'false');
    }

    async function loadProfile() {
        const data = await userRequest('/api/user/profile');
        applyAvatar(data.avatar?.dataUrl || null);
    }

    function profileAvatarInputToDataUrl(file) {
        return new Promise((resolve, reject) => {
            if (!file || !IMAGE_TYPES.has(file.type) || file.size > MAX_AVATAR_INPUT_BYTES) {
                reject(new Error('รูปโปรไฟล์ต้องเป็น JPEG, PNG หรือ WEBP ขนาดไม่เกิน 2 MB'));
                return;
            }
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('ไม่สามารถอ่านรูปโปรไฟล์ได้'));
            reader.onload = () => {
                const image = new Image();
                image.onerror = () => reject(new Error('ไม่สามารถประมวลผลรูปโปรไฟล์ได้'));
                image.onload = () => {
                    const size = 256;
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const context = canvas.getContext('2d');
                    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
                    const width = image.naturalWidth * scale;
                    const height = image.naturalHeight * scale;
                    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.84));
                };
                image.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    async function openAvatarModal() {
        showModal('profileAvatarModal');
        pendingAvatarDataUrl = null;
        document.getElementById('profileAvatarInput').value = '';
        document.getElementById('profileAvatarStatus').textContent = savedAvatarDataUrl ? 'รูปปัจจุบันจัดเก็บไว้กับบัญชีของคุณ' : 'ยังไม่มีรูปโปรไฟล์';
        applyAvatar(savedAvatarDataUrl);
    }

    async function chooseAvatar(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            pendingAvatarDataUrl = await profileAvatarInputToDataUrl(file);
            const preview = document.getElementById('profileAvatarPreview');
            preview.src = pendingAvatarDataUrl;
            preview.classList.remove('hidden');
            document.getElementById('profileAvatarInitial').textContent = initialForUser();
            document.getElementById('profileAvatarStatus').textContent = 'พร้อมบันทึกรูปใหม่ ขนาดจะถูกลดให้เหมาะสม';
        } catch (error) {
            pendingAvatarDataUrl = null;
            setModalStatus('profileAvatarStatus', error.message, 'error');
        }
    }

    async function saveAvatar() {
        if (!pendingAvatarDataUrl) {
            setModalStatus('profileAvatarStatus', 'กรุณาเลือกรูปก่อนบันทึก', 'error');
            return;
        }
        const button = document.getElementById('saveProfileAvatarButton');
        button.disabled = true;
        button.textContent = 'กำลังบันทึก…';
        try {
            const data = await userRequest('/api/user/avatar', { method: 'POST', body: JSON.stringify({ dataUrl: pendingAvatarDataUrl }) });
            applyAvatar(data.avatar.dataUrl);
            pendingAvatarDataUrl = null;
            document.getElementById('profileAvatarInput').value = '';
            setModalStatus('profileAvatarStatus', data.message, 'success');
        } catch (error) {
            setModalStatus('profileAvatarStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'บันทึกรูป';
        }
    }

    async function removeAvatar() {
        const button = document.getElementById('removeProfileAvatarButton');
        button.disabled = true;
        button.textContent = 'กำลังลบ…';
        try {
            const data = await userRequest('/api/user/avatar/remove', { method: 'POST', body: JSON.stringify({}) });
            pendingAvatarDataUrl = null;
            document.getElementById('profileAvatarInput').value = '';
            applyAvatar(null);
            setModalStatus('profileAvatarStatus', data.message, 'success');
        } catch (error) {
            setModalStatus('profileAvatarStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'ลบรูป';
        }
    }

    function historyEmptyMessage() {
        const fragment = document.createDocumentFragment();
        const wrapper = document.createElement('div');
        wrapper.className = 'flex items-start gap-3';
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', 'history');
        icon.className = 'h-6 w-6 text-teal-600';
        const text = document.createElement('div');
        const title = document.createElement('p');
        title.className = 'font-bold text-slate-800';
        title.textContent = 'ยังไม่มีประวัติการสแกนที่บันทึกไว้';
        const description = document.createElement('p');
        description.className = 'mt-1 text-xs leading-relaxed text-slate-500';
        description.textContent = 'หน้าแสกนปัจจุบันแสดงภาพเฉพาะบนอุปกรณ์และไม่ส่งภาพไปจัดเก็บ จึงยังไม่มีรายการใน Timeline';
        text.append(title, description);
        wrapper.append(icon, text);
        fragment.append(wrapper);
        return fragment;
    }

    async function openTimeline() {
        showModal('userTimelineModal');
        const content = document.getElementById('userTimelineContent');
        content.className = 'mt-5 rounded-2xl border border-slate-100 bg-slate-50 p-5 text-sm text-slate-600';
        content.textContent = 'กำลังโหลดประวัติ…';
        try {
            const data = await userRequest('/api/user/history');
            content.replaceChildren();
            if (!data.history?.length) {
                content.append(historyEmptyMessage());
            } else {
                const list = document.createElement('div');
                list.className = 'space-y-3';
                data.history.forEach((entry) => {
                    const item = document.createElement('article');
                    item.className = 'rounded-xl border border-slate-200 bg-white p-4';
                    const title = document.createElement('p');
                    title.className = 'font-bold text-slate-800';
                    title.textContent = entry.resultLabel || 'รายการสแกนที่บันทึกไว้';
                    const meta = document.createElement('p');
                    meta.className = 'mt-1 text-xs leading-relaxed text-slate-500';
                    const confidence = entry.confidence === null || entry.confidence === undefined ? '' : ` · ความมั่นใจ ${(entry.confidence * 100).toFixed(1)}%`;
                    meta.textContent = `${formatDate(entry.createdAt)} · ${entry.source || 'upload'}${confidence}`;
                    item.append(title, meta);
                    list.append(item);
                });
                content.append(list);
            }
            refreshIcons();
        } catch (error) {
            content.textContent = error.message;
            content.className = 'mt-5 rounded-2xl border border-rose-100 bg-rose-50 p-5 text-sm text-rose-700';
        }
    }

    function locationOnce() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับตำแหน่งปัจจุบัน'));
            navigator.geolocation.getCurrentPosition(resolve, (error) => {
                if (error.code === error.PERMISSION_DENIED) reject(new Error('ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง โปรดตรวจการตั้งค่าเบราว์เซอร์'));
                else reject(new Error('ไม่สามารถระบุตำแหน่งปัจจุบันได้ กรุณาลองใหม่'));
            }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 });
        });
    }

    function addRadarMetric(container, label, value) {
        const card = document.createElement('div');
        card.className = 'rounded-xl border border-teal-100 bg-teal-50 p-3';
        const name = document.createElement('p');
        name.className = 'text-[10px] font-bold uppercase tracking-wide text-teal-700';
        name.textContent = label;
        const result = document.createElement('p');
        result.className = 'mt-1 text-base font-extrabold text-slate-800';
        result.textContent = value;
        card.append(name, result);
        container.append(card);
    }

    async function loadNearbyEnvironment() {
        if (!document.getElementById('nearbyConsentInput').checked) {
            setModalStatus('nearbyRadarStatus', 'กรุณายินยอมก่อนให้เบราว์เซอร์ขอพิกัด', 'error');
            return;
        }
        const button = document.getElementById('nearbyRadarLoadButton');
        button.disabled = true;
        button.textContent = 'กำลังตรวจข้อมูล…';
        setModalStatus('nearbyRadarStatus', 'กำลังขอตำแหน่งจากเบราว์เซอร์…');
        try {
            const position = await locationOnce();
            const { latitude, longitude } = position.coords;
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,relative_humidity_2m,uv_index`;
            const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=pm2_5`;
            const [weatherResponse, airResponse] = await Promise.all([fetch(weatherUrl), fetch(airUrl)]);
            if (!weatherResponse.ok || !airResponse.ok) throw new Error('ไม่สามารถเรียกข้อมูลสภาพแวดล้อมได้ในขณะนี้');
            const [weather, air] = await Promise.all([weatherResponse.json(), airResponse.json()]);
            const result = document.getElementById('nearbyRadarResult');
            result.replaceChildren();
            addRadarMetric(result, 'อุณหภูมิ', `${weather.current?.temperature_2m ?? '–'} °C`);
            addRadarMetric(result, 'ความชื้น', `${weather.current?.relative_humidity_2m ?? '–'}%`);
            addRadarMetric(result, 'UV index', `${weather.current?.uv_index ?? '–'}`);
            addRadarMetric(result, 'PM2.5', `${air.current?.pm2_5 ?? '–'} µg/m³`);
            result.classList.remove('hidden');
            setModalStatus('nearbyRadarStatus', 'ข้อมูลเรียกใช้ตามตำแหน่งปัจจุบันแบบครั้งเดียวและไม่ได้บันทึกพิกัดในบัญชี', 'success');
        } catch (error) {
            setModalStatus('nearbyRadarStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="map-pin" class="h-4 w-4 text-teal-300"></i>ใช้ตำแหน่งปัจจุบัน';
            refreshIcons();
        }
    }

    function openAccountInfo(kind) {
        const title = document.getElementById('accountInfoTitle');
        const description = document.getElementById('accountInfoDescription');
        const content = document.getElementById('accountInfoContent');
        if (kind === 'terms') {
            title.textContent = 'ข้อกำหนดการใช้งาน';
            description.textContent = 'หลักการใช้งานพื้นที่บัญชีและหน้าแสกน';
            content.textContent = 'ระบบนี้ให้ข้อมูลเพื่อช่วยการดูแลผิวทั่วไปและการเตรียมข้อมูล ไม่ใช่การวินิจฉัยหรือการรักษาโดยแพทย์ หากมีแผล เลือดออก ปวดมาก หรือผื่นลาม ควรพบแพทย์หรือผู้เชี่ยวชาญโดยเร็ว';
        } else {
            title.textContent = 'ความเป็นส่วนตัวและข้อมูล';
            description.textContent = 'ข้อมูลที่ใช้ในบัญชีผู้ใช้';
            content.textContent = 'รูปที่เลือกหรือถ่ายในหน้าแสกนปัจจุบันแสดงตัวอย่างอยู่บนอุปกรณ์ และไม่ถูกอัปโหลดหรือจัดเก็บในระบบ รูปโปรไฟล์ ข้อความถึงผู้ดูแล และประวัติที่ระบบตั้งค่าให้บันทึก สามารถจัดการหรือลบบัญชีได้จากเมนูนี้';
        }
        showModal('accountInfoModal');
    }

    async function submitChangePassword(event) {
        event.preventDefault();
        const button = document.getElementById('changePasswordSubmitButton');
        button.disabled = true;
        button.textContent = 'กำลังบันทึก…';
        try {
            const data = await userRequest('/api/user/password', {
                method: 'POST',
                body: JSON.stringify({
                    currentPassword: document.getElementById('currentPasswordInput').value,
                    newPassword: document.getElementById('newPasswordInput').value,
                    confirmation: document.getElementById('confirmPasswordInput').value,
                }),
            });
            event.currentTarget.reset();
            setModalStatus('changePasswordStatus', data.message, 'success');
        } catch (error) {
            setModalStatus('changePasswordStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'บันทึกรหัสผ่านใหม่';
        }
    }

    async function submitFeedback(event) {
        event.preventDefault();
        const button = document.getElementById('feedbackSubmitButton');
        button.disabled = true;
        button.textContent = 'กำลังส่ง…';
        try {
            const data = await userRequest('/api/user/feedback', { method: 'POST', body: JSON.stringify({ message: document.getElementById('feedbackMessageInput').value }) });
            event.currentTarget.reset();
            setModalStatus('feedbackStatus', data.message, 'success');
        } catch (error) {
            setModalStatus('feedbackStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'ส่งข้อความ';
        }
    }

    async function submitDeleteAccount(event) {
        event.preventDefault();
        const button = document.getElementById('deleteAccountSubmitButton');
        button.disabled = true;
        button.textContent = 'กำลังลบบัญชี…';
        try {
            await userRequest('/api/user/delete', { method: 'POST', body: JSON.stringify({ confirmation: document.getElementById('deleteConfirmationInput').value, password: document.getElementById('deletePasswordInput').value }) });
            window.location.replace('/');
        } catch (error) {
            setModalStatus('deleteAccountStatus', error.message, 'error');
            button.disabled = false;
            button.textContent = 'ลบบัญชีถาวร';
        }
    }

    async function requireSession() {
        try {
            const response = await fetch('/api/account/me', { credentials: 'same-origin' });
            const data = await response.json();
            if (!response.ok || !data.user) throw new Error('missing session');
            currentUser = data.user;
            if (data.user.role === 'admin') {
                document.getElementById('dashboardAdminLink').classList.remove('hidden');
                document.getElementById('dashboardHomeLink').classList.add('hidden');
            } else {
                document.getElementById('dashboardUserName').textContent = data.user.name;
                document.getElementById('userMenuName').textContent = data.user.name;
                document.getElementById('userMenuEmail').textContent = data.user.email || '';
                document.getElementById('userAccountControl').classList.remove('hidden');
                applyAvatar(null);
                try { await loadProfile(); } catch { /* Account menu remains usable even if avatar is unavailable. */ }
            }
            document.getElementById('dashboardLoading').classList.add('hidden');
            document.getElementById('dashboardMain').classList.remove('hidden');
        } catch {
            window.location.replace('/');
        }
    }

    function openLogoutModal() {
        closeUserMenu();
        showModal('dashboardLogoutModal');
        document.getElementById('dashboardLogoutConfirmButton').focus();
    }

    function closeLogoutModal() {
        closeModal('dashboardLogoutModal');
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
        document.getElementById('menuLogoutButton').addEventListener('click', openLogoutModal);
        document.getElementById('dashboardLogoutCancelButton').addEventListener('click', closeLogoutModal);
        document.getElementById('dashboardLogoutConfirmButton').addEventListener('click', logout);
        document.getElementById('dashboardLogoutModal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeLogoutModal(); });

        document.getElementById('userAccountButton').addEventListener('click', openUserMenu);
        document.getElementById('profileAvatarMenuItem').addEventListener('click', openAvatarModal);
        document.getElementById('profileAvatarInput').addEventListener('change', chooseAvatar);
        document.getElementById('saveProfileAvatarButton').addEventListener('click', saveAvatar);
        document.getElementById('removeProfileAvatarButton').addEventListener('click', removeAvatar);
        document.getElementById('userTimelineButton').addEventListener('click', openTimeline);
        document.getElementById('nearbyEnvironmentRadarButton').addEventListener('click', () => showModal('nearbyRadarModal'));
        document.getElementById('nearbyRadarLoadButton').addEventListener('click', loadNearbyEnvironment);
        document.getElementById('termsMenuItem').addEventListener('click', () => openAccountInfo('terms'));
        document.getElementById('privacyMenuItem').addEventListener('click', () => openAccountInfo('privacy'));
        document.getElementById('changePasswordMenuItem').addEventListener('click', () => { document.getElementById('changePasswordForm').reset(); setModalStatus('changePasswordStatus', ''); showModal('changePasswordModal'); });
        document.getElementById('feedbackMenuItem').addEventListener('click', () => { document.getElementById('feedbackForm').reset(); setModalStatus('feedbackStatus', ''); showModal('feedbackModal'); });
        document.getElementById('accountDeletionMenuItem').addEventListener('click', () => { document.getElementById('deleteAccountForm').reset(); setModalStatus('deleteAccountStatus', ''); showModal('deleteAccountModal'); });
        document.getElementById('changePasswordForm').addEventListener('submit', submitChangePassword);
        document.getElementById('feedbackForm').addEventListener('submit', submitFeedback);
        document.getElementById('deleteAccountForm').addEventListener('submit', submitDeleteAccount);

        document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
        document.querySelectorAll('[role="dialog"]').forEach((modal) => modal.addEventListener('click', (event) => {
            if (event.target !== modal || modal.id === 'dashboardLogoutModal') return;
            if (modal.id === 'dashboardCameraModal') closeCamera();
            else closeModal(modal.id);
        }));
        document.addEventListener('click', (event) => {
            const control = document.getElementById('userAccountControl');
            if (control && !control.contains(event.target)) closeUserMenu();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (!document.getElementById('dashboardLogoutModal').classList.contains('hidden')) return closeLogoutModal();
            closeUserMenu();
            closeAllAccountModals();
            if (!document.getElementById('dashboardCameraModal').classList.contains('hidden')) closeCamera();
        });
        window.addEventListener('pagehide', stopCamera);
        requireSession();
    });
})();
