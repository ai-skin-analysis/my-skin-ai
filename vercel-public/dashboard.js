(() => {
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const MAX_AVATAR_INPUT_BYTES = 2 * 1024 * 1024;
    const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
    let previewUrl = '';
    let cameraStream = null;
    let currentUser = null;
    let savedAvatarDataUrl = null;
    let pendingAvatarDataUrl = null;
    let selectedScanImage = null;
    let selectedScanSource = 'upload';
    let privateStorageReady = false;
    let dashboardAlertTimer = null;

    function refreshIcons() {
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function setStatus(message, tone = 'info') {
        const status = document.getElementById('dashboardImageStatus');
        if (!status) return;
        status.className = 'sr-only';
        status.textContent = message;
        const processing = document.getElementById('dashboardProcessingModal');
        if (tone === 'error' && processing?.classList.contains('hidden')) showDashboardAlert(message);
    }

    function showDashboardAlert(message) {
        const toast = document.getElementById('dashboardAlertToast');
        const toastMessage = document.getElementById('dashboardAlertToastMessage');
        if (!toast || !toastMessage) return;
        toastMessage.textContent = message;
        toast.classList.remove('hidden');
        window.clearTimeout(dashboardAlertTimer);
        dashboardAlertTimer = window.setTimeout(() => toast.classList.add('hidden'), 7500);
        refreshIcons();
    }

    function selectedImageName() {
        return selectedScanImage?.name ? `ภาพ “${selectedScanImage.name}”` : 'รูปภาพที่เลือก';
    }

    function setProcessingImageState(message, tone = 'info') {
        const panel = document.getElementById('dashboardProcessingImageState');
        if (!panel) return;
        panel.dataset.tone = tone;
        const text = panel.querySelector('p');
        if (text) text.textContent = message;
    }

    const PROCESSING_STAGES = {
        prepare: { title: 'กำลังตรวจความพร้อมของภาพ', detail: 'กำลังลบข้อมูลเมตาและปรับขนาดภาพบนอุปกรณ์ของคุณ', step: 0 },
        authorize: { title: 'กำลังขอสิทธิ์อัปโหลด', detail: 'กำลังสร้างสิทธิ์อัปโหลดชั่วคราวสำหรับบัญชีของคุณ', step: 1 },
        upload: { title: 'กำลังส่งภาพผ่านการเข้ารหัส', detail: 'กำลังส่งภาพไปยังพื้นที่ส่วนตัวของบัญชีคุณ', step: 2 },
        commit: { title: 'กำลังบันทึกการแสกนภาพ', detail: 'กำลังเพิ่มรายการเข้าไปในประวัติการแสกนของคุณ', step: 3 },
        complete: { title: 'แสกนภาพเสร็จแล้ว', detail: 'คุณสามารถเปิดดูรายการนี้ได้จากเมนูโปรไฟล์ → ประวัติการแสกน', step: 4 },
    };

    function setProcessingStage(stage) {
        const current = PROCESSING_STAGES[stage] || PROCESSING_STAGES.prepare;
        const modal = document.getElementById('dashboardProcessingModal');
        if (!modal) return;
        modal.dataset.processing = stage === 'complete' ? 'complete' : 'active';
        document.getElementById('dashboardProcessingTitle').textContent = current.title;
        document.getElementById('dashboardProcessingDetail').textContent = current.detail;
        document.getElementById('dashboardProcessingError').classList.add('hidden');
        document.getElementById('dashboardProcessingCloseButton').classList.add('hidden');
        const imageStates = {
            prepare: `${selectedImageName()} ยังอยู่บนอุปกรณ์ของคุณ ระบบกำลังเตรียมข้อมูลก่อนส่ง`,
            authorize: `${selectedImageName()} ถูกเตรียมแล้วและยังอยู่บนอุปกรณ์ กำลังขอสิทธิ์อัปโหลดเฉพาะรายการ`,
            upload: `กำลังส่ง ${selectedImageName()} ไปยังพื้นที่ส่วนตัวผ่านการเชื่อมต่อที่เข้ารหัส`,
            commit: `${selectedImageName()} ถูกส่งถึงพื้นที่ส่วนตัวแล้ว กำลังบันทึกประวัติการสแกน`,
            complete: `${selectedImageName()} ถูกจัดเก็บและบันทึกในประวัติการสแกนเรียบร้อยแล้ว`,
        };
        setProcessingImageState(imageStates[stage] || imageStates.prepare);
        document.querySelectorAll('[data-processing-step]').forEach((item) => {
            const itemStep = Number(item.dataset.processingStep);
            item.dataset.state = itemStep < current.step ? 'complete' : itemStep === current.step ? 'active' : 'pending';
        });
        if (modal.classList.contains('hidden')) showModal('dashboardProcessingModal');
        refreshIcons();
    }

    function showProcessingError(message, imageState) {
        const modal = document.getElementById('dashboardProcessingModal');
        if (!modal) return;
        modal.dataset.processing = 'error';
        document.getElementById('dashboardProcessingTitle').textContent = 'ยังไม่สามารถจัดเก็บภาพได้';
        document.getElementById('dashboardProcessingDetail').textContent = 'ภาพต้นฉบับยังอยู่บนอุปกรณ์ของคุณ และยังไม่ถูกบันทึกเป็นประวัติ';
        document.getElementById('dashboardProcessingError').textContent = message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่';
        document.getElementById('dashboardProcessingError').classList.remove('hidden');
        document.getElementById('dashboardProcessingCloseButton').classList.remove('hidden');
        setProcessingImageState(imageState || `${selectedImageName()} ยังอยู่บนอุปกรณ์ของคุณ และยังไม่ได้ถูกบันทึกเป็นประวัติ`, 'error');
        document.querySelectorAll('[data-processing-step]').forEach((item) => { item.dataset.state = 'error'; });
        if (modal.classList.contains('hidden')) showModal('dashboardProcessingModal');
        refreshIcons();
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

    function renderSystemAvatarIcon(element, size) {
        element.replaceChildren();
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', 'user-round');
        icon.className = size;
        element.append(icon);
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
            if (!dataUrl) renderSystemAvatarIcon(element, element.id === 'profileAvatarInitial' ? 'h-8 w-8' : 'h-4 w-4');
            element.classList.toggle('hidden', Boolean(dataUrl));
        });
        refreshIcons();
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
        if (id === 'dashboardProcessingModal') modal.dataset.processing = 'idle';
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

    function presentImage(file, source, scanSource = 'upload') {
        if (!isAllowedImage(file)) return;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(file);
        selectedScanImage = file;
        selectedScanSource = scanSource;
        document.getElementById('dashboardImagePreview').src = previewUrl;
        document.getElementById('dashboardImageMeta').textContent = `${source}: ${file.name} · ${formatSize(file.size)}`;
        document.getElementById('dashboardImagePlaceholder').classList.add('hidden');
        document.getElementById('dashboardImagePreviewPanel').classList.remove('hidden');
        document.getElementById('dashboardLesionImageInput').checked = false;
        document.getElementById('dashboardScanConsentInput').checked = false;
        const submit = document.getElementById('dashboardSubmitScanButton');
        submit.disabled = !privateStorageReady;
        submit.innerHTML = privateStorageReady
            ? '<i data-lucide="scan-line" class="h-4 w-4"></i>เริ่มแสกนภาพ'
            : '<i data-lucide="database-zap" class="h-4 w-4"></i>พื้นที่ส่วนตัวยังอยู่ระหว่างการตั้งค่า';
        setStatus(privateStorageReady
            ? 'ภาพพร้อมแสกนแล้ว กรุณายืนยันข้อมูลภาพและความยินยอม จากนั้นกดเริ่มแสกนภาพ'
            : 'ภาพยังอยู่บนอุปกรณ์ของคุณ พื้นที่จัดเก็บส่วนตัวยังอยู่ระหว่างการตั้งค่า จึงยังส่งภาพไม่ได้', privateStorageReady ? 'success' : 'info');
        refreshIcons();
    }

    function clearImage() {
        const input = document.getElementById('dashboardImageInput');
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        selectedScanImage = null;
        selectedScanSource = 'upload';
        if (input) input.value = '';
        document.getElementById('dashboardImagePreview').removeAttribute('src');
        document.getElementById('dashboardImagePlaceholder').classList.remove('hidden');
        document.getElementById('dashboardImagePreviewPanel').classList.add('hidden');
        document.getElementById('dashboardLesionImageInput').checked = false;
        document.getElementById('dashboardScanConsentInput').checked = false;
        setStatus('ล้างภาพจากหน้าปัจจุบันแล้ว ไม่มีภาพถูกเก็บหรือส่งออกจากอุปกรณ์', 'info');
    }

    async function preparePrivateScanImage(file) {
        if (!window.createImageBitmap) throw new Error('เบราว์เซอร์นี้ไม่รองรับการเตรียมภาพส่วนตัว กรุณาใช้เบราว์เซอร์รุ่นใหม่');
        let bitmap;
        try { bitmap = await createImageBitmap(file); }
        catch { throw new Error('ไม่สามารถอ่านรูปภาพนี้ได้ กรุณาเลือกไฟล์ภาพใหม่'); }
        try {
            const limit = 2048;
            const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d', { alpha: false });
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            context.drawImage(bitmap, 0, 0, width, height);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            if (!blob || !blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('ไม่สามารถเตรียมภาพให้อยู่ในขนาดที่ปลอดภัยได้ กรุณาเลือกภาพที่เล็กลง');
            return new File([blob], `skin-scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
        } finally {
            bitmap.close?.();
        }
    }

    async function submitPrivateScan() {
        if (!privateStorageReady) {
            setStatus('พื้นที่จัดเก็บภาพส่วนตัวยังอยู่ระหว่างการตั้งค่า กรุณาลองใหม่ภายหลัง', 'error');
            return;
        }
        if (!selectedScanImage) {
            setStatus('ไม่พบภาพสำหรับส่ง ระบบยังไม่ได้รับไฟล์จากอุปกรณ์ของคุณ กรุณาเลือกภาพใหม่', 'error');
            return;
        }
        if (!document.getElementById('dashboardLesionImageInput').checked) {
            setStatus('กรุณายืนยันว่าภาพแสดงผิวหนังของมนุษย์ที่มีรอยโรคหรือผื่น ก่อนเริ่มแสกนภาพ', 'error');
            return;
        }
        if (!document.getElementById('dashboardScanConsentInput').checked) {
            setStatus('กรุณายืนยันสิทธิ์และความยินยอมก่อนส่งภาพ', 'error');
            return;
        }
        const button = document.getElementById('dashboardSubmitScanButton');
        const imageName = selectedScanImage.name || 'รูปภาพที่เลือก';
        let uploadedToPrivateStorage = false;
        button.disabled = true;
        button.textContent = 'กำลังเริ่มแสกนภาพ…';
        try {
            setProcessingStage('prepare');
            const preparedImage = await preparePrivateScanImage(selectedScanImage);
            button.textContent = 'กำลังตรวจความพร้อมของภาพ…';
            setProcessingStage('authorize');
            const uploadRequest = await userRequest('/api/user/scan/upload', {
                method: 'POST',
                body: JSON.stringify({
                    consent: true,
                    originalName: preparedImage.name,
                    mimeType: preparedImage.type,
                    imageSizeBytes: preparedImage.size,
                    source: selectedScanSource,
                }),
            });
            button.textContent = 'กำลังส่งภาพผ่านการเข้ารหัส…';
            setProcessingStage('upload');
            const uploadResponse = await fetch(uploadRequest.upload.url, {
                method: 'PUT',
                headers: { 'Content-Type': preparedImage.type, 'x-upsert': 'false' },
                body: preparedImage,
            });
            if (!uploadResponse.ok) throw new Error('ไม่สามารถอัปโหลดภาพไปยังพื้นที่ส่วนตัวได้ กรุณาลองใหม่');
            uploadedToPrivateStorage = true;
            button.textContent = 'กำลังบันทึกการแสกนภาพ…';
            setProcessingStage('commit');
            const completed = await userRequest('/api/user/scan/complete', {
                method: 'POST',
                body: JSON.stringify({ uploadId: uploadRequest.upload.id }),
            });
            selectedScanImage = null;
            document.getElementById('dashboardImageInput').value = '';
            document.getElementById('dashboardLesionImageInput').checked = false;
            document.getElementById('dashboardScanConsentInput').checked = false;
            button.textContent = 'แสกนภาพเสร็จแล้ว';
            setStatus(`แสกนภาพเสร็จแล้ว · ${completed.message} · รายการถูกเพิ่มในประวัติการแสกนของคุณ`, 'success');
            setProcessingStage('complete');
            setProcessingImageState(`ภาพ “${imageName}” ผ่านขั้นตอนแสกนและบันทึกในประวัติเรียบร้อยแล้ว ระบบยังไม่แสดงผลจำแนกโรค`);
            window.setTimeout(() => closeModal('dashboardProcessingModal'), 1000);
        } catch (error) {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="scan-line" class="h-4 w-4"></i>เริ่มแสกนภาพ';
            setStatus(error.message || 'ไม่สามารถเริ่มแสกนภาพได้ กรุณาลองใหม่', 'error');
            showProcessingError(
                error.message || 'ไม่สามารถเริ่มแสกนภาพได้ กรุณาลองใหม่',
                uploadedToPrivateStorage
                    ? `ภาพ “${imageName}” ถูกส่งถึงพื้นที่ส่วนตัวแล้ว แต่ยังบันทึกประวัติไม่สำเร็จ ระบบจะไม่แสดงรายการนี้จนกว่าจะยืนยันการบันทึกได้`
                    : `ภาพ “${imageName}” ยังอยู่บนอุปกรณ์ของคุณ และยังไม่ได้ถูกจัดเก็บในพื้นที่ส่วนตัว`,
            );
            refreshIcons();
        }
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
            presentImage(photo, 'ถ่ายจากกล้อง', 'camera');
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
            document.getElementById('profileAvatarInitial').classList.add('hidden');
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
            button.textContent = 'บันทึกรูปโปรไฟล์';
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
            button.textContent = 'ลบรูปโปรไฟล์';
        }
    }

    function historyEmptyMessage() {
        const fragment = document.createDocumentFragment();
        const wrapper = document.createElement('div');
        wrapper.className = 'mt-10 flex min-h-56 flex-col items-center justify-center text-center';
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', 'folder');
        icon.className = 'mb-4 h-20 w-20 stroke-[1.5] text-slate-200';
        const text = document.createElement('div');
        const title = document.createElement('p');
        title.className = 'text-xl font-extrabold text-slate-700';
        title.textContent = 'คุณยังไม่มีประวัติการสแกน';
        const description = document.createElement('p');
        description.className = 'mt-2 text-sm font-medium text-slate-400';
        description.textContent = 'เมื่อเริ่มแสกนภาพสำเร็จ รายการของคุณจะแสดงที่นี่';
        text.append(title, description);
        wrapper.append(icon, text);
        fragment.append(wrapper);
        return fragment;
    }

    async function openTimeline() {
        showModal('userTimelineModal');
        const content = document.getElementById('userTimelineContent');
        document.getElementById('timelineUserName').textContent = `${currentUser?.name || 'ผู้ใช้งานทั่วไป'} (USER)`;
        document.getElementById('timelineUserEmail').textContent = currentUser?.email || 'user@example.com';
        content.className = 'min-h-48 flex-1 text-sm text-slate-600';
        content.textContent = 'กำลังโหลดประวัติ…';
        try {
            const data = await userRequest('/api/user/history');
            content.replaceChildren();
            if (!data.history?.length) {
                content.append(historyEmptyMessage());
            } else {
                const list = document.createElement('div');
                list.className = 'relative ml-4 space-y-5 border-l-2 border-teal-100 pb-4';
                data.history.forEach((entry) => {
                    const container = document.createElement('div');
                    container.className = 'relative pl-6';
                    const marker = document.createElement('span');
                    marker.className = 'absolute -left-[9px] top-4 h-4 w-4 rounded-full bg-teal-500 ring-4 ring-white shadow-sm';
                    const item = document.createElement('article');
                    item.className = 'relative overflow-hidden rounded-2xl border border-slate-100 bg-white p-4 shadow-sm';
                    const accent = document.createElement('span');
                    accent.className = 'absolute inset-y-0 left-0 w-1 bg-teal-500';
                    const title = document.createElement('p');
                    title.className = 'pl-2 font-extrabold text-teal-700';
                    title.textContent = entry.resultLabel || 'รายการสแกนที่บันทึกไว้';
                    const meta = document.createElement('p');
                    meta.className = 'mt-2 pl-2 text-xs leading-relaxed text-slate-500';
                    const confidence = entry.confidence === null || entry.confidence === undefined ? '' : ` · ความมั่นใจ ${(entry.confidence * 100).toFixed(1)}%`;
                    meta.textContent = `${formatDate(entry.createdAt)} · ${entry.source || 'upload'}${confidence}`;
                    item.append(accent, title, meta);
                    container.append(marker, item);
                    list.append(container);
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

    function renderNearbyContext(context) {
        const deleteButton = document.getElementById('nearbyContextDeleteButton');
        if (!context) {
            document.getElementById('nearbyPm25').textContent = '—';
            document.getElementById('nearbyUv').textContent = '—';
            document.getElementById('nearbyHumidity').textContent = '—';
            document.getElementById('nearbyTemperature').textContent = '—';
            document.getElementById('nearbyContextLevel').textContent = 'ยังไม่มีข้อมูลบริบทพื้นที่';
            document.getElementById('nearbyContextSummary').textContent = 'กดปุ่มด้านล่างเพื่อเลือกแชร์ตำแหน่งโดยประมาณครั้งนี้';
            document.getElementById('nearbyContextLocation').textContent = '';
            deleteButton.classList.add('hidden');
            return;
        }
        document.getElementById('nearbyPm25').textContent = Number(context.pm25).toFixed(1);
        document.getElementById('nearbyUv').textContent = Number(context.uvIndex).toFixed(1);
        document.getElementById('nearbyHumidity').textContent = `${Math.round(Number(context.relativeHumidity))}%`;
        document.getElementById('nearbyTemperature').textContent = `${Number(context.temperatureC).toFixed(1)}°C`;
        document.getElementById('nearbyContextLevel').textContent = context.contextLevel;
        document.getElementById('nearbyContextSummary').textContent = `${context.contextSummary} ใช้ประกอบการดูแลผิวทั่วไปเท่านั้น ไม่ใช่การวินิจฉัยโรคผิวหนัง`;
        document.getElementById('nearbyContextLocation').textContent = `อัปเดต ${formatDate(context.updatedAt)} · พิกัดโดยประมาณ ${Number(context.latitudeApprox).toFixed(2)}, ${Number(context.longitudeApprox).toFixed(2)} · หมดอายุ ${formatDate(context.retentionExpiresAt)}`;
        deleteButton.classList.remove('hidden');
    }

    async function openNearbyRadar() {
        document.getElementById('nearbyConsentInput').checked = false;
        showModal('nearbyRadarModal');
        setModalStatus('nearbyRadarStatus', 'กำลังตรวจข้อมูลบริบทพื้นที่ล่าสุด…');
        try {
            const data = await userRequest('/api/user/nearby-context');
            renderNearbyContext(data.context);
            setModalStatus('nearbyRadarStatus', data.context
                ? 'แสดงบริบทล่าสุดที่คุณเคยยินยอมไว้ คุณลบข้อมูลนี้ได้ทุกเมื่อ'
                : 'ระบบจะขอสิทธิ์ตำแหน่งเมื่อคุณยืนยันและกดปุ่มเท่านั้น');
        } catch (error) {
            renderNearbyContext(null);
            setModalStatus('nearbyRadarStatus', error.message, 'error');
        }
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
            const latitude = Number(position.coords.latitude.toFixed(2));
            const longitude = Number(position.coords.longitude.toFixed(2));
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,relative_humidity_2m,uv_index`;
            const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=pm2_5`;
            const [weatherResponse, airResponse] = await Promise.all([fetch(weatherUrl), fetch(airUrl)]);
            if (!weatherResponse.ok || !airResponse.ok) throw new Error('ไม่สามารถเรียกข้อมูลสภาพแวดล้อมได้ในขณะนี้');
            const [weather, air] = await Promise.all([weatherResponse.json(), airResponse.json()]);
            const pm25 = Number(air.current?.pm2_5);
            const uvIndex = Number(weather.current?.uv_index);
            const relativeHumidity = Number(weather.current?.relative_humidity_2m);
            const temperatureC = Number(weather.current?.temperature_2m);
            if (![pm25, uvIndex, relativeHumidity, temperatureC].every(Number.isFinite)) {
                throw new Error('ข้อมูลสภาพแวดล้อมจากบริการสาธารณะไม่ครบถ้วน กรุณาลองใหม่');
            }
            setModalStatus('nearbyRadarStatus', 'กำลังบันทึกเฉพาะบริบทล่าสุดแบบพิกัดโดยประมาณ…');
            const data = await userRequest('/api/user/nearby-context/save', {
                method: 'POST',
                body: JSON.stringify({ consent: true, latitude, longitude, pm25, uvIndex, relativeHumidity, temperatureC }),
            });
            renderNearbyContext(data.context);
            setModalStatus('nearbyRadarStatus', 'บันทึกบริบทสภาพแวดล้อมล่าสุดแล้ว เก็บเฉพาะพิกัดโดยประมาณและลบได้ทุกเมื่อ', 'success');
        } catch (error) {
            setModalStatus('nearbyRadarStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="locate-fixed" class="h-4 w-4"></i>ยินยอมและตรวจบริบทพื้นที่';
            refreshIcons();
        }
    }

    async function deleteNearbyContext() {
        if (!window.confirm('ลบพิกัดโดยประมาณและข้อมูลสภาพแวดล้อมล่าสุดของคุณใช่หรือไม่?')) return;
        const button = document.getElementById('nearbyContextDeleteButton');
        button.disabled = true;
        button.textContent = 'กำลังลบ…';
        try {
            const data = await userRequest('/api/user/nearby-context/delete', { method: 'POST', body: JSON.stringify({}) });
            renderNearbyContext(null);
            setModalStatus('nearbyRadarStatus', data.message, 'success');
        } catch (error) {
            setModalStatus('nearbyRadarStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="trash-2" class="h-4 w-4"></i>ลบข้อมูลพื้นที่';
            refreshIcons();
        }
    }

    function appendAccountInfoSection(container, heading, body) {
        const section = document.createElement('section');
        const title = document.createElement('h3');
        title.className = 'font-bold text-slate-900';
        title.textContent = heading;
        const detail = document.createElement('p');
        detail.className = 'mt-1';
        detail.textContent = body;
        section.append(title, detail);
        container.append(section);
    }

    function openAccountInfo(kind) {
        const title = document.getElementById('accountInfoTitle');
        const description = document.getElementById('accountInfoDescription');
        const kicker = document.getElementById('accountInfoKicker');
        const content = document.getElementById('accountInfoContent');
        content.replaceChildren();
        if (kind === 'terms') {
            kicker.textContent = 'SMART SKIN AI · TERMS';
            title.textContent = 'ข้อกำหนดการใช้งาน';
            description.textContent = 'หลักการใช้งานพื้นที่บัญชีและหน้าแสกน';
            appendAccountInfoSection(content, '1. ขอบเขตบริการ', 'บริการนี้ให้ข้อมูลเพื่อช่วยการดูแลผิวทั่วไปและการเตรียมข้อมูล ไม่ใช่การวินิจฉัย การรักษา หรือบริการฉุกเฉิน และไม่ควรใช้แทนการตัดสินใจทางการแพทย์ด้วยตนเอง');
            appendAccountInfoSection(content, '2. ความปลอดภัยของผู้ใช้', 'หากมีรอยโรคใหม่หรือเปลี่ยนแปลงเร็ว เลือดออก แผลไม่หาย ปวดมาก มีไข้ ผื่นลามเร็ว หรือมีความกังวล ให้ติดต่อแพทย์ผิวหนังหรือบริการฉุกเฉินในพื้นที่ทันที');
            appendAccountInfoSection(content, '3. ภาพและบัญชี', 'ส่งได้เฉพาะภาพผิวหนังที่คุณมีสิทธิ์ใช้ และควรปกปิดข้อมูลระบุตัวตนที่ไม่จำเป็น ภาพจะยังอยู่บนอุปกรณ์จนกว่าคุณจะยืนยันความยินยอมและกดเริ่มแสกน จากนั้นระบบจะลบข้อมูลเมตาที่ไม่จำเป็นก่อนส่งผ่านการเชื่อมต่อที่เข้ารหัส');
            appendAccountInfoSection(content, '4. ข้อมูลส่วนบุคคล', 'คุณจัดการรูปโปรไฟล์ รหัสผ่าน ข้อความถึงผู้ดูแล บริบทสภาพแวดล้อมล่าสุด และลบบัญชีได้จากเมนูบัญชีของคุณ');
            appendAccountInfoSection(content, '5. การเปลี่ยนแปลง', 'เมื่อเงื่อนไขหรือฟังก์ชันมีการเปลี่ยนแปลงอย่างมีนัยสำคัญ ระบบจะแจ้งให้ผู้ใช้ทราบก่อนใช้งานข้อมูลเพิ่มเติม');
        } else {
            kicker.textContent = 'SMART SKIN AI · PDPA';
            title.textContent = 'ประกาศความเป็นส่วนตัวและ PDPA';
            description.textContent = 'คำอธิบายแบบเข้าใจง่ายเกี่ยวกับการเก็บ ใช้ ปกป้อง และลบข้อมูลส่วนบุคคลตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)';
            appendAccountInfoSection(content, 'PDPA เกี่ยวข้องกับภาพผิวหนังอย่างไร', 'ภาพรอยโรคผิวหนังอาจเปิดเผยข้อมูลสุขภาพ ซึ่งเป็นข้อมูลส่วนบุคคลที่มีความอ่อนไหว ระบบจึงขอความยินยอมอย่างชัดเจนก่อนส่งภาพ คุณไม่จำเป็นต้องใช้ฟังก์ชันแสกนหรือเรดาร์เพื่อใช้ข้อมูลทั่วไปของเว็บไซต์');
            appendAccountInfoSection(content, 'ผู้ควบคุมข้อมูลและช่องทางติดต่อ', 'ผู้ดูแลระบบ Smart Skin AI เป็นผู้ควบคุมข้อมูลสำหรับบริการนี้ หากต้องการสอบถาม แจ้งปัญหา ถอนความยินยอม หรือใช้สิทธิตาม PDPA ให้เลือก “ส่งข้อความถึงผู้ดูแล” จากเมนูบัญชีผู้ใช้');
            appendAccountInfoSection(content, 'ข้อมูลที่ระบบอาจจัดเก็บ', 'ข้อมูลบัญชี เช่น ชื่อและอีเมล รูปโปรไฟล์ที่เลือกบันทึก ภาพผิวหนังที่คุณยืนยันและกดเริ่มแสกน ประวัติรายการแสกน ข้อความถึงผู้ดูแล และบริบทสภาพแวดล้อมจากตำแหน่งโดยประมาณเมื่อคุณยินยอม ภาพที่เพียงเลือกดูตัวอย่างจะยังอยู่บนอุปกรณ์จนกว่าคุณจะกดเริ่มแสกน');
            appendAccountInfoSection(content, 'วัตถุประสงค์ในการใช้ข้อมูล', 'ใช้เพื่อยืนยันบัญชี ให้บริการฟังก์ชันที่คุณเลือก แสดงประวัติส่วนบุคคล รักษาความปลอดภัย และตอบคำขอของผู้ใช้ ระบบไม่ขายข้อมูลส่วนบุคคลและไม่ใช้ภาพผิวหนังเพื่อการโฆษณา');
            appendAccountInfoSection(content, 'ความยินยอมและการถอนความยินยอม', 'ฟังก์ชันแสกนภาพและเรดาร์จะขอความยินยอมแยกกันก่อนส่งข้อมูล คุณถอนความยินยอมและขอลบข้อมูลได้ทุกเมื่อผ่านเมนูบัญชีหรือส่งข้อความถึงผู้ดูแล การถอนความยินยอมไม่กระทบการประมวลผลที่ชอบด้วยกฎหมายก่อนถอน');
            appendAccountInfoSection(content, 'ระยะเวลาเก็บรักษา', 'ภาพและประวัติการแสกนมีรอบหมดอายุของระบบ โดยค่าเริ่มต้นไม่เกิน 30 วัน บริบทตำแหน่งโดยประมาณเก็บเฉพาะรายการล่าสุดไม่เกิน 24 ชั่วโมง รูปโปรไฟล์เก็บจนกว่าคุณจะเปลี่ยน ลบ หรือปิดบัญชี เมื่อหมดความจำเป็นระบบจะลบหรือทำให้ไม่สามารถเชื่อมโยงกลับมาหาคุณได้ตามความเหมาะสม');
            appendAccountInfoSection(content, 'การเข้าถึงและผู้ให้บริการภายนอก', 'เฉพาะผู้ดูแลที่ได้รับสิทธิ์และผู้ให้บริการโครงสร้างพื้นฐานที่จำเป็นต่อการทำงานของระบบเท่านั้นที่อาจประมวลผลข้อมูล ระบบใช้พื้นที่จัดเก็บส่วนตัวสำหรับภาพ และจะติดต่อ Open-Meteo เพื่อเรียกข้อมูลอากาศเมื่อคุณอนุญาตตำแหน่งโดยประมาณเท่านั้น');
            appendAccountInfoSection(content, 'สิทธิของคุณตาม PDPA', 'ภายใต้เงื่อนไขของกฎหมาย คุณอาจขอเข้าถึงหรือรับสำเนาข้อมูล ขอแก้ไข ขอให้ลบหรือจำกัดการใช้ คัดค้าน ขอรับหรือโอนข้อมูล ถอนความยินยอม และร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคลได้');
            appendAccountInfoSection(content, 'การรักษาความปลอดภัย', 'ระบบใช้การเชื่อมต่อแบบเข้ารหัส จำกัดสิทธิ์ตามบัญชี ลบข้อมูลเมตาที่ไม่จำเป็นจากภาพก่อนส่ง และไม่แสดงรหัสผ่านแก่ผู้ดูแล อย่างไรก็ตามไม่มีระบบออนไลน์ใดรับประกันความปลอดภัยได้ทั้งหมด จึงควรหลีกเลี่ยงการส่งข้อมูลที่ไม่จำเป็น');
            appendAccountInfoSection(content, 'การลบข้อมูลและปิดบัญชี', 'คุณลบรูปโปรไฟล์ บริบทพื้นที่ และปิดบัญชีพร้อมข้อมูลที่เกี่ยวข้องได้จากเมนูบัญชี การปิดบัญชีเป็นการดำเนินการถาวร หากต้องการลบเฉพาะรายการหรือใช้สิทธิอื่น ให้ส่งคำขอถึงผู้ดูแล');
            appendAccountInfoSection(content, 'ข้อควรระวังด้านสุขภาพ', 'ข้อมูลจากระบบใช้ประกอบการดูแลผิวทั่วไป ไม่ใช่การวินิจฉัยหรือการรักษา หากรอยโรคเปลี่ยนแปลงเร็ว มีเลือดออก แผลไม่หาย ปวดมาก มีไข้ หรือผื่นลามเร็ว ให้พบแพทย์หรือบริการฉุกเฉินในพื้นที่ทันที');
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
            button.textContent = 'ส่งข้อเสนอแนะ';
        }
    }

    function selectedDeletionMode() {
        return document.querySelector('input[name="deleteDataMode"]:checked')?.value || 'history';
    }

    function updateDeletionDialog() {
        const deletingAccount = selectedDeletionMode() === 'account';
        document.getElementById('deleteAccountDescription').textContent = deletingAccount
            ? 'บัญชีและข้อมูลที่เกี่ยวข้องทั้งหมดจะถูกลบถาวร และคุณจะออกจากระบบทันที'
            : 'ลบเฉพาะภาพและประวัติการแสกนทั้งหมด โดยบัญชีของคุณยังใช้งานได้ตามปกติ';
        document.getElementById('deleteAcknowledgementText').textContent = deletingAccount
            ? 'ฉันเข้าใจว่าบัญชีและข้อมูลทั้งหมดจะถูกลบถาวรและไม่สามารถกู้คืนได้'
            : 'ฉันเข้าใจว่าประวัติการแสกนที่ลบแล้วไม่สามารถกู้คืนได้';
        document.getElementById('deleteAccountSubmitButton').textContent = deletingAccount
            ? 'ลบบัญชีถาวร'
            : 'ลบประวัติการแสกน';
    }

    function openDeletionModal() {
        document.getElementById('deleteAccountForm').reset();
        document.getElementById('deleteModeHistory').checked = true;
        setModalStatus('deleteAccountStatus', '');
        updateDeletionDialog();
        showModal('deleteAccountModal');
    }

    async function submitDeleteAccount(event) {
        event.preventDefault();
        const mode = selectedDeletionMode();
        const button = document.getElementById('deleteAccountSubmitButton');
        button.disabled = true;
        button.textContent = mode === 'account' ? 'กำลังลบบัญชี…' : 'กำลังลบประวัติ…';
        try {
            const password = document.getElementById('deletePasswordInput').value;
            if (mode === 'account') {
                await userRequest('/api/user/delete', { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE', password }) });
                window.location.replace('/');
                return;
            }
            const data = await userRequest('/api/user/scan/delete-all', {
                method: 'POST',
                body: JSON.stringify({ confirmed: document.getElementById('deleteAcknowledgementInput').checked, password }),
            });
            event.currentTarget.reset();
            document.getElementById('deleteModeHistory').checked = true;
            updateDeletionDialog();
            setModalStatus('deleteAccountStatus', data.message, data.complete === false ? 'error' : 'success');
        } catch (error) {
            setModalStatus('deleteAccountStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            updateDeletionDialog();
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
                document.getElementById('dashboardLogoutButton').classList.remove('hidden');
            } else {
                document.getElementById('dashboardUserName').textContent = data.user.name;
                document.getElementById('userMenuName').textContent = data.user.name;
                document.getElementById('userMenuEmail').textContent = data.user.email || '';
                document.getElementById('userAccountControl').classList.remove('hidden');
                applyAvatar(null);
                try { await loadProfile(); } catch { /* Account menu remains usable even if avatar is unavailable. */ }
                try {
                    const storage = await userRequest('/api/user/storage-status');
                    privateStorageReady = storage.configured === true;
                } catch {
                    privateStorageReady = false;
                }
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
        const trigger = currentUser?.role === 'admin' ? document.getElementById('dashboardLogoutButton') : document.getElementById('menuLogoutButton');
        trigger?.focus();
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
            if (file) presentImage(file, 'เลือกจากอุปกรณ์', 'upload');
        });
        document.getElementById('dashboardOpenCameraButton').addEventListener('click', openCamera);
        document.getElementById('dashboardClearImageButton').addEventListener('click', clearImage);
        document.getElementById('dashboardSubmitScanButton').addEventListener('click', submitPrivateScan);
        document.getElementById('dashboardCloseCameraButton').addEventListener('click', closeCamera);
        document.getElementById('dashboardCancelCameraButton').addEventListener('click', closeCamera);
        document.getElementById('dashboardTakePhotoButton').addEventListener('click', takePhoto);
        document.getElementById('dashboardLogoutButton').addEventListener('click', openLogoutModal);
        document.getElementById('menuLogoutButton').addEventListener('click', openLogoutModal);
        document.getElementById('dashboardLogoutCancelButton').addEventListener('click', closeLogoutModal);
        document.getElementById('dashboardLogoutConfirmButton').addEventListener('click', logout);
        document.getElementById('dashboardLogoutModal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeLogoutModal(); });
        document.getElementById('dashboardProcessingCloseButton').addEventListener('click', () => closeModal('dashboardProcessingModal'));

        document.getElementById('userAccountButton').addEventListener('click', openUserMenu);
        document.getElementById('profileAvatarMenuItem').addEventListener('click', openAvatarModal);
        document.getElementById('profileAvatarInput').addEventListener('change', chooseAvatar);
        document.getElementById('saveProfileAvatarButton').addEventListener('click', saveAvatar);
        document.getElementById('removeProfileAvatarButton').addEventListener('click', removeAvatar);
        document.getElementById('userTimelineButton').addEventListener('click', openTimeline);
        document.getElementById('nearbyEnvironmentRadarButton').addEventListener('click', openNearbyRadar);
        document.getElementById('nearbyRadarLoadButton').addEventListener('click', loadNearbyEnvironment);
        document.getElementById('nearbyContextDeleteButton').addEventListener('click', deleteNearbyContext);
        document.getElementById('termsMenuItem').addEventListener('click', () => openAccountInfo('terms'));
        document.getElementById('privacyMenuItem').addEventListener('click', () => openAccountInfo('privacy'));
        document.getElementById('changePasswordMenuItem').addEventListener('click', () => { document.getElementById('changePasswordForm').reset(); setModalStatus('changePasswordStatus', ''); showModal('changePasswordModal'); });
        document.getElementById('feedbackMenuItem').addEventListener('click', () => { document.getElementById('feedbackForm').reset(); setModalStatus('feedbackStatus', ''); showModal('feedbackModal'); });
        document.getElementById('accountDeletionMenuItem').addEventListener('click', openDeletionModal);
        document.querySelectorAll('input[name="deleteDataMode"]').forEach((input) => input.addEventListener('change', () => {
            document.getElementById('deleteAcknowledgementInput').checked = false;
            setModalStatus('deleteAccountStatus', '');
            updateDeletionDialog();
        }));
        document.getElementById('changePasswordForm').addEventListener('submit', submitChangePassword);
        document.getElementById('feedbackForm').addEventListener('submit', submitFeedback);
        document.getElementById('deleteAccountForm').addEventListener('submit', submitDeleteAccount);

        document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
        document.querySelectorAll('[role="dialog"]').forEach((modal) => modal.addEventListener('click', (event) => {
            if (event.target !== modal || modal.id === 'dashboardLogoutModal' || modal.id === 'dashboardProcessingModal') return;
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
