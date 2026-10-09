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
    let imageSelectionVersion = 0;
    let cameraSessionVersion = 0;
    let scanResultModule;
    let sessionCheckPending = false;
    let scanRequestPending = false;
    let pendingAnalysisScreen = null;
    const getScanResultModule = () => scanResultModule ||= import('./research-result.js').catch(error => {
        scanResultModule = undefined;
        throw error;
    });

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

    // A single user-facing analysis dialog replaces the technical checklist.
    // Preparation, consent, quality and authorization still run before inference.
    const ANALYSIS_PROGRESS = {
        prepare: 'กำลังเริ่มต้นคำขอวิเคราะห์ภาพของคุณ',
        inspect: 'กำลังเตรียมภาพสำหรับการวิเคราะห์ด้วยปัญญาประดิษฐ์',
        authorize: 'กำลังเชื่อมต่อบริการวิเคราะห์อย่างปลอดภัย',
        upload: 'กำลังส่งภาพที่คุณยินยอมให้บริการ AI ผ่านการเชื่อมต่อที่เข้ารหัส',
        commit: 'โมเดล AI กำลังวิเคราะห์ลักษณะและจำแนกกลุ่มรอยโรคจากภาพ กรุณารอสักครู่',
    };

    function setProcessingStage(stage) {
        const modal = document.getElementById('dashboardProcessingModal');
        if (!modal) return;
        modal.dataset.processing = 'active';
        document.getElementById('dashboardProcessingTitle').textContent = 'วิเคราะห์และจำแนกรอยโรคผิวหนังด้วยปัญญาประดิษฐ์';
        document.getElementById('dashboardProcessingDetail').textContent = ANALYSIS_PROGRESS[stage] || ANALYSIS_PROGRESS.prepare;
        document.getElementById('dashboardProcessingError').classList.add('hidden');
        document.getElementById('dashboardProcessingResultButton').classList.add('hidden');
        document.getElementById('dashboardProcessingImageState').classList.add('hidden');
        const closeButton = document.getElementById('dashboardProcessingCloseButton');
        closeButton.textContent = 'ปิดและลองใหม่';
        closeButton.classList.add('hidden');
        if (modal.classList.contains('hidden')) showModal('dashboardProcessingModal');
        refreshIcons();
    }

    function showProcessingComplete(completed, presenter, options) {
        // Validate the same response as the next screen before claiming that
        // processing finished. Completion is not a successful classification.
        presenter.completedAnalysisView(completed);
        pendingAnalysisScreen = { completed, presenter, options };
        const modal = document.getElementById('dashboardProcessingModal');
        modal.dataset.processing = 'complete';
        document.getElementById('dashboardProcessingTitle').textContent = 'ประมวลผลภาพเสร็จแล้ว';
        document.getElementById('dashboardProcessingDetail').textContent = 'กด “ดูผลวิเคราะห์และจำแนก” เพื่อเปิดหน้าผลถัดไป การประมวลผลเสร็จไม่ได้หมายความว่า AI จำแนกรอยโรคได้แน่นอน';
        document.getElementById('dashboardProcessingImageState').classList.add('hidden');
        document.getElementById('dashboardProcessingError').classList.add('hidden');
        document.getElementById('dashboardProcessingCloseButton').classList.add('hidden');
        const next = document.getElementById('dashboardProcessingResultButton');
        next.classList.remove('hidden');
        if (modal.classList.contains('hidden')) showModal('dashboardProcessingModal');
        next.focus();
    }

    function openCompletedAnalysis() {
        if (!pendingAnalysisScreen || document.getElementById('dashboardProcessingModal').dataset.processing !== 'complete') return;
        const { completed, presenter, options } = pendingAnalysisScreen;
        try {
            // Presentation only: no upload, re-scan, storage or model call.
            presenter.renderAnalysisScreen(document, completed, options);
            closeModal('dashboardProcessingModal');
            document.getElementById('dashboardAnalysisTitle').focus();
            window.scrollTo?.({ top: 0, behavior: 'auto' });
        } catch {
            // Keep the completed response in memory so this button can retry
            // opening the view without retransmitting the private image.
            document.getElementById('dashboardProcessingError').textContent = 'ยังเปิดหน้าผลไม่ได้ กรุณากดดูผลอีกครั้ง ระบบจะไม่ส่งภาพหรือสแกนซ้ำ';
            document.getElementById('dashboardProcessingError').classList.remove('hidden');
        }
    }

    const LESION_IMAGE_GUIDANCE = 'ข้อมูลผิดพลาด กรุณาใช้ภาพรอยโรคผิวหนังของมนุษย์ที่เห็นบริเวณรอยโรคชัดเจน ไม่ใช้ภาพสิ่งของ สัตว์ อาหาร เอกสาร ภาพหน้าจอ วิว หรือภาพอื่นที่ไม่เกี่ยวข้อง';

    function scanError(code, message) {
        return Object.assign(new Error(message), { code });
    }

    function scanFailureMessage(error) {
        if (error?.code === 'OUT_OF_SCOPE' || error?.code === 'NO_LESION_DETECTED' || error?.code === 'NON_SKIN_IMAGE') return LESION_IMAGE_GUIDANCE;
        if (error?.code === 'UNCERTAIN_CONTENT') return 'ระบบยังตรวจสอบไม่ได้อย่างมั่นใจว่าเป็นภาพรอยโรคผิวหนัง จึงหยุดการจำแนก กรุณาถ่ายภาพรอยโรคให้ชัดเจนแล้วลองใหม่';
        if (error?.code === 'UNSUPPORTED_LESION') return 'ขออภัย ระบบยังไม่รองรับหรือไม่สามารถจำแนกรอยโรคในภาพนี้ได้อย่างน่าเชื่อถือ จึงไม่ระบุชื่อรอยโรค โปรดพบแพทย์ผู้เชี่ยวชาญด้านผิวหนังเพื่อรับการประเมิน';
        if (error?.code === 'UNCERTAIN_CLASSIFICATION') return 'ระบบยังแยกกลุ่มรอยโรคในภาพนี้ได้ไม่ชัดเจน จึงไม่แสดงชื่อกลุ่มที่อาจทำให้เข้าใจผิด โปรดพบแพทย์ผู้เชี่ยวชาญด้านผิวหนังเพื่อรับการประเมิน';
        return error?.message || 'ไม่สามารถเริ่มแสกนภาพได้ กรุณาลองใหม่';
    }

    function showProcessingError(message, imageState, code) {
        const modal = document.getElementById('dashboardProcessingModal');
        if (!modal) return;
        pendingAnalysisScreen = null;
        modal.dataset.processing = 'error';
        document.getElementById('dashboardProcessingResultButton').classList.add('hidden');
        document.getElementById('dashboardProcessingImageState').classList.remove('hidden');
        document.getElementById('dashboardProcessingTitle').textContent = ['OUT_OF_SCOPE', 'NO_LESION_DETECTED', 'NO_IMAGE', 'INVALID_IMAGE', 'NON_SKIN_IMAGE'].includes(code)
            ? 'ข้อมูลผิดพลาด' : code === 'MODEL_UNAVAILABLE' ? 'ระบบวิเคราะห์ภาพยังไม่พร้อม'
                : code === 'UNSUPPORTED_LESION' ? 'รอยโรคนี้ยังไม่อยู่ในขอบเขตที่ระบบจำแนกได้'
                    : code === 'UNCERTAIN_CLASSIFICATION' ? 'ยังไม่สามารถสรุปกลุ่มรอยโรคได้' : 'ยังไม่สามารถแสกนภาพได้';
        document.getElementById('dashboardProcessingDetail').textContent = code === 'NO_IMAGE'
            ? 'ยังไม่ได้รับภาพ กรุณาเลือกภาพหรือถ่ายภาพรอยโรคใหม่'
            : ['UNSUPPORTED_LESION', 'UNCERTAIN_CLASSIFICATION'].includes(code)
                ? 'ผลนี้ไม่ได้หมายความว่าผิวปกติหรือไม่มีโรค และไม่ใช่ผลวินิจฉัยทางการแพทย์'
                : 'ยังไม่สามารถดำเนินการให้เสร็จได้ โปรดตรวจสถานะรูปภาพด้านล่าง';
        document.getElementById('dashboardProcessingError').textContent = message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่';
        document.getElementById('dashboardProcessingError').classList.remove('hidden');
        document.getElementById('dashboardProcessingCloseButton').classList.remove('hidden');
        document.getElementById('dashboardProcessingCloseButton').textContent = ['UNSUPPORTED_LESION', 'UNCERTAIN_CLASSIFICATION'].includes(code) ? 'รับทราบ' : 'ปิดและลองใหม่';
        setProcessingImageState(imageState || `${selectedImageName()} ยังอยู่บนอุปกรณ์ของคุณ และยังไม่ได้ถูกบันทึกเป็นประวัติ`, 'error');
        if (modal.classList.contains('hidden')) showModal('dashboardProcessingModal');
        document.getElementById('dashboardProcessingCloseButton').focus();
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
        if (id === 'dashboardProcessingModal') {
            document.getElementById('dashboardMain').inert = true;
            document.getElementById('dashboardProcessingTitle').focus();
        }
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        if (id === 'dashboardProcessingModal') {
            modal.dataset.processing = 'idle';
            pendingAnalysisScreen = null;
            document.getElementById('dashboardProcessingResultButton').classList.add('hidden');
            document.getElementById('dashboardMain').inert = false;
        }
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
        if (!response.ok || !data.ok) throw scanError(data.code, data.message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง');
        return data;
    }

    async function refreshPrivateStorageStatus() {
        // A dashboard can remain open across a storage outage or configuration
        // change. Never use its initial status to authorize a later upload.
        privateStorageReady = false;
        try {
            const storage = await userRequest('/api/user/storage-status', { cache: 'no-store' });
            privateStorageReady = storage.configured === true;
        } catch {
            // A failed check must not retain a previously successful status.
            privateStorageReady = false;
        }
        return privateStorageReady;
    }

    function isAllowedImage(file) {
        if (!file || !(IMAGE_TYPES.has(file.type) || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name)))) {
            setStatus('ข้อมูลผิดพลาด กรุณาใช้ภาพรอยโรคผิวหนังในรูปแบบ JPG, JPEG, PNG หรือ WEBP เท่านั้น', 'error');
            return false;
        }
        if (!file.size || file.size > MAX_IMAGE_BYTES) {
            setStatus('ภาพต้องมีขนาดไม่เกิน 8 MB กรุณาเลือกไฟล์ที่เล็กลง', 'error');
            return false;
        }
        return true;
    }

    async function decodeScanImage(file) {
        if (typeof window.createImageBitmap === 'function') {
            try { return await createImageBitmap(file); } catch { /* Try the browser image decoder too. */ }
        }
        const url = URL.createObjectURL(file);
        try {
            const image = await new Promise((resolve, reject) => {
                const candidate = new Image();
                candidate.onload = () => resolve(candidate);
                candidate.onerror = () => reject(new Error('ไม่สามารถอ่านรูปภาพนี้ได้ กรุณาเลือกไฟล์ภาพใหม่'));
                candidate.src = url;
            });
            return image;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function presentImage(file, source, scanSource = 'upload', stillCurrent = () => true) {
        if (scanRequestPending) return false;
        const version = ++imageSelectionVersion;
        const submit = document.getElementById('dashboardSubmitScanButton');
        if (!isAllowedImage(file)) {
            submit.disabled = !selectedScanImage;
            return false;
        }
        submit.disabled = true;
        try {
            const decoded = await decodeScanImage(file);
            try {
                if (!decoded.width || !decoded.height || decoded.width * decoded.height > 40000000) {
                    throw new Error('ภาพมีขนาดใหญ่เกินไป กรุณาลดความละเอียดให้ไม่เกิน 40 ล้านพิกเซล');
                }
            } finally { decoded.close?.(); }
        } catch (error) {
            if (version === imageSelectionVersion) {
                submit.disabled = !selectedScanImage;
                if (stillCurrent()) setStatus(error.message || 'ไม่สามารถอ่านรูปภาพได้ กรุณาเลือกภาพใหม่', 'error');
            }
            return false;
        }
        if (version !== imageSelectionVersion || !stillCurrent()) {
            if (version === imageSelectionVersion) submit.disabled = !selectedScanImage;
            return false;
        }
        if (pendingAnalysisScreen) closeModal('dashboardProcessingModal');
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
        submit.disabled = false;
        submit.innerHTML = '<i data-lucide="scan-line" class="h-4 w-4"></i>เริ่มแสกนภาพ';
        setStatus(privateStorageReady
            ? 'ภาพพร้อมแสกนแล้ว กรุณายืนยันข้อมูลภาพและความยินยอม จากนั้นกดเริ่มแสกนภาพ'
            : 'ภาพพร้อมแสกนบนอุปกรณ์ หากพื้นที่ส่วนตัวยังไม่พร้อม ระบบจะไม่ส่งหรือเก็บไฟล์ภาพ', privateStorageReady ? 'success' : 'info');
        refreshIcons();
        return true;
    }

    function clearImage() {
        if (scanRequestPending) return;
        if (pendingAnalysisScreen) closeModal('dashboardProcessingModal');
        imageSelectionVersion += 1;
        const input = document.getElementById('dashboardImageInput');
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        selectedScanImage = null;
        selectedScanSource = 'upload';
        if (input) input.value = '';
        document.getElementById('dashboardNativeCameraInput').value = '';
        document.getElementById('dashboardImageMeta').textContent = '';
        document.getElementById('dashboardSubmitScanButton').disabled = true;
        document.getElementById('dashboardImagePreview').removeAttribute('src');
        document.getElementById('dashboardImagePlaceholder').classList.remove('hidden');
        document.getElementById('dashboardImagePreviewPanel').classList.add('hidden');
        document.getElementById('dashboardLesionImageInput').checked = false;
        document.getElementById('dashboardScanConsentInput').checked = false;
        setStatus('ล้างภาพออกจากหน้าปัจจุบันแล้ว ไม่ส่งภาพใหม่ และไม่ลบประวัติที่บันทึกไว้ก่อนหน้า', 'info');
    }

    async function preparePrivateScanImage(file) {
        let bitmap;
        try { bitmap = await decodeScanImage(file); }
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

    async function inspectPreparedScanImage(file) {
        let bitmap;
        try { bitmap = await decodeScanImage(file); }
        catch { throw new Error('ไม่สามารถแสกนข้อมูลภาพนี้ได้ กรุณาเลือกภาพใหม่'); }
        try {
            const sampleEdge = 192;
            const scale = Math.min(1, sampleEdge / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
            context.drawImage(bitmap, 0, 0, width, height);
            const pixels = context.getImageData(0, 0, width, height).data;
            const luminance = new Float32Array(width * height);
            let sum = 0;
            let clippedDark = 0;
            let clippedLight = 0;
            for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index += 1) {
                const value = (pixels[pixel] * 0.2126) + (pixels[pixel + 1] * 0.7152) + (pixels[pixel + 2] * 0.0722);
                luminance[index] = value;
                sum += value;
                if (value < 5) clippedDark += 1;
                if (value > 250) clippedLight += 1;
            }
            const mean = sum / luminance.length;
            let variance = 0;
            let edgeTotal = 0;
            let edgeCount = 0;
            for (let y = 1; y < height - 1; y += 1) {
                for (let x = 1; x < width - 1; x += 1) {
                    const index = (y * width) + x;
                    variance += (luminance[index] - mean) ** 2;
                    edgeTotal += Math.abs(luminance[index + 1] - luminance[index - 1]);
                    edgeTotal += Math.abs(luminance[index + width] - luminance[index - width]);
                    edgeCount += 2;
                }
            }
            const contrast = Math.sqrt(variance / Math.max(1, (width - 2) * (height - 2)));
            const edgeScore = edgeTotal / Math.max(1, edgeCount);
            // Average brightness alone can penalize naturally dark skin. Only
            // nearly blank/clipped images are rejected by this technical check.
            // None of these measurements determine whether a lesion is present.
            if (clippedDark / luminance.length > 0.95 || clippedLight / luminance.length > 0.95) {
                return { status: 'retake-light', summary: 'ภาพมืดหรือสว่างเกินไป ยังไม่สามารถวิเคราะห์รอยโรคได้ กรุณาถ่ายใหม่ด้วยแสงที่พอดี' };
            }
            if (contrast < 2 && edgeScore < 0.5) {
                return { status: 'retake-focus', summary: 'ภาพไม่คมชัดเพียงพอ ยังไม่สามารถวิเคราะห์รอยโรคได้ กรุณาถ่ายใหม่โดยโฟกัสบริเวณรอยโรค' };
            }
            return { status: 'ready', summary: 'ตรวจข้อมูลภาพเบื้องต้นแล้ว ยังไม่ได้ยืนยันว่าเป็นภาพรอยโรคผิวหนัง',
                qualityWarning: mean < 45 || mean > 225 || contrast < 18 || edgeScore < 4.5
                    ? 'หากรายละเอียดรอยโรคไม่ชัด แนะนำให้ปรับแสงและโฟกัสแล้วถ่ายใหม่' : null };
        } finally {
            bitmap.close?.();
        }
    }

    async function submitPrivateScan() {
        if (scanRequestPending || pendingAnalysisScreen) return;
        if (!selectedScanImage) {
            const message = 'ข้อมูลผิดพลาด ไม่พบภาพ กรุณาอัปโหลดหรือถ่ายภาพรอยโรคผิวหนังที่เห็นบริเวณรอยโรคชัดเจน';
            setStatus(message, 'error');
            showProcessingError(message, 'ยังไม่มีภาพถูกส่งหรือบันทึก', 'NO_IMAGE');
            return;
        }
        if (!document.getElementById('dashboardLesionImageInput').checked) {
            const message = 'กรุณายืนยันว่าภาพแสดงรอยโรคผิวหนังของมนุษย์ก่อนเริ่มแสกน การยืนยันนี้ไม่ใช่ผลการตรวจจากโมเดล';
            setStatus(message, 'error');
            showProcessingError(message);
            return;
        }
        if (!document.getElementById('dashboardScanConsentInput').checked) {
            setStatus('กรุณายืนยันสิทธิ์และความยินยอมก่อนส่งภาพ', 'error');
            return;
        }
        const button = document.getElementById('dashboardSubmitScanButton');
        const imageName = selectedScanImage.name || 'รูปภาพที่เลือก';
        let uploadAttempted = false;
        let uploadedToPrivateStorage = false;
        let storedImage = false;
        scanRequestPending = true;
        button.disabled = true;
        button.textContent = 'กำลังวิเคราะห์และจำแนกด้วยปัญญาประดิษฐ์…';
        try {
            setProcessingStage('prepare');
            const preparedImage = await preparePrivateScanImage(selectedScanImage);
            setProcessingStage('inspect');
            const inspection = await inspectPreparedScanImage(preparedImage);
            if (inspection.status !== 'ready') throw scanError('POOR_QUALITY', inspection.summary);
            // Do not upload, record success, or silently downgrade to quality-only
            // scanning when the actual semantic detector/classifier is unavailable.
            const readiness = await userRequest('/api/user/scan/research/readiness');
            if (readiness.researchAvailable !== true || readiness.releaseStatus !== 'research_only'
                || readiness.classCount !== 3 || readiness.modelVersion !== 'scin3-local-baab96df5bf5') {
                throw scanError('MODEL_UNAVAILABLE', readiness.message || 'ระบบวิเคราะห์และคัดกรองภาพรอยโรคยังไม่พร้อมใช้งาน');
            }
            if (!await refreshPrivateStorageStatus()) {
                throw scanError('PRIVATE_STORAGE_UNAVAILABLE', 'พื้นที่ส่วนตัวสำหรับส่งภาพยังไม่พร้อม ระบบยังไม่ได้ส่งภาพหรือบันทึกผล กรุณาลองใหม่ภายหลัง');
            }
            // Load presentation before sending a private image; failed storage
            // or semantic checks must never fall back to a quality-only record.
            const resultPresenter = await getScanResultModule();
            setProcessingStage('authorize');
            const uploadRequest = await userRequest('/api/user/scan/research/upload', {
                method: 'POST',
                body: JSON.stringify({
                    consent: true,
                    researchConsentVersion: 'skin-demo-scin3-20261009-v1',
                    originalName: preparedImage.name,
                    mimeType: preparedImage.type,
                    imageSizeBytes: preparedImage.size,
                    source: selectedScanSource,
                    qualityStatus: inspection.status,
                }),
            });
            setProcessingStage('upload');
            uploadAttempted = true;
            const uploadResponse = await fetch(uploadRequest.upload.url, {
                method: 'PUT',
                headers: { 'Content-Type': preparedImage.type, 'x-upsert': 'false' },
                body: preparedImage,
            });
            if (!uploadResponse.ok) throw new Error('ไม่สามารถอัปโหลดภาพไปยังพื้นที่ส่วนตัวได้');
            uploadedToPrivateStorage = true;
            button.textContent = 'กำลังวิเคราะห์และจำแนกรอยโรค…';
            setProcessingStage('commit');
            const completed = await userRequest('/api/user/scan/research/complete', {
                method: 'POST',
                body: JSON.stringify({ uploadId: uploadRequest.upload.id, researchConsentVersion: 'skin-demo-scin3-20261009-v1' }),
            });
            storedImage = completed.storedImage === true;
            // Storage acknowledgement / brightness is not a classification.
            // A future inference adapter must return an authoritative result.
            const resultView = resultPresenter.researchResultView(completed?.analysis);
            if (resultView.code === 'NON_SKIN_IMAGE') {
                showProcessingError(resultView.message,
                    completed.temporaryUploadDeleted === true
                        ? 'ลบภาพที่ส่งชั่วคราวออกจากพื้นที่ส่วนตัวแล้ว ไม่บันทึกเป็นผลจำแนก ภาพต้นฉบับยังอยู่บนอุปกรณ์ของคุณ'
                        : 'ภาพถูกส่งไปประมวลผลแล้ว โปรดตรวจสถานะพื้นที่ส่วนตัว', resultView.code);
                return;
            }
            if (!['RESEARCH_ONLY', 'UNCERTAIN_CLASSIFICATION'].includes(resultView.code)) {
                throw scanError(resultView.code, resultView.message);
            }
            showProcessingComplete(completed, resultPresenter, {
                imageName,
                previewUrl: document.getElementById('dashboardImagePreview').src,
            });
            selectedScanImage = null;
            document.getElementById('dashboardImageInput').value = '';
            document.getElementById('dashboardLesionImageInput').checked = false;
            document.getElementById('dashboardScanConsentInput').checked = false;
            button.textContent = 'ประมวลผลภาพแล้ว';
            setStatus(completed.message || resultView.message, resultView.code === 'RESEARCH_ONLY' ? 'success' : 'info');
        } catch (error) {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="scan-line" class="h-4 w-4"></i>เริ่มแสกนภาพ';
            const message = scanFailureMessage(error);
            setStatus(message, 'error');
            showProcessingError(
                message,
                storedImage
                    ? `ภาพ “${imageName}” ถูกเก็บในพื้นที่ส่วนตัวและบันทึกรายการแล้ว แต่ยังไม่มีผลจำแนกที่ตรวจสอบได้`
                    : uploadedToPrivateStorage
                        ? `ภาพ “${imageName}” ถูกส่งถึงพื้นที่ส่วนตัวแล้ว แต่ยังยืนยันการบันทึกประวัติไม่ได้`
                        : uploadAttempted
                            ? `การส่งภาพ “${imageName}” ขัดข้อง ระบบยังยืนยันไม่ได้ว่าภาพถึงพื้นที่ส่วนตัวหรือไม่ ภาพต้นฉบับยังอยู่บนอุปกรณ์ของคุณ`
                            : `ภาพ “${imageName}” ยังอยู่บนอุปกรณ์ของคุณ และยังไม่ได้ถูกจัดเก็บในพื้นที่ส่วนตัว`,
                error.code,
            );
            refreshIcons();
        } finally {
            scanRequestPending = false;
            if (selectedScanImage) {
                button.disabled = false;
                button.textContent = 'เริ่มสแกนภาพเชิงทดลอง';
            }
        }
    }

    function returnToScan() {
        if (scanRequestPending) return;
        closeModal('dashboardProcessingModal');
        document.getElementById('dashboardAnalysisImage').removeAttribute('src');
        document.getElementById('dashboardAnalysisResult').replaceChildren();
        document.getElementById('dashboardAnalysisView').classList.add('hidden');
        document.getElementById('dashboardScanView').classList.remove('hidden');
        clearImage();
        document.title = 'หน้าสแกนภาพผิวหนัง | Smart Skin AI';
        document.getElementById('scanHeroTitle').focus();
        window.scrollTo?.({ top: 0, behavior: 'auto' });
    }

    function stopCamera() {
        cameraSessionVersion += 1;
        if (cameraStream) {
            cameraStream.getTracks().forEach((track) => track.stop());
            cameraStream = null;
        }
        const video = document.getElementById('dashboardCameraStream');
        if (video) video.srcObject = null;
        document.getElementById('dashboardTakePhotoButton').disabled = true;
    }

    function closeCamera() {
        stopCamera();
        closeModal('dashboardCameraModal');
    }

    async function openCamera() {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            document.getElementById('dashboardNativeCameraInput').click();
            return;
        }
        stopCamera();
        const version = cameraSessionVersion;
        const status = document.getElementById('dashboardCameraStatus');
        const captureButton = document.getElementById('dashboardTakePhotoButton');
        status.textContent = 'กำลังเปิดกล้อง กรุณาอนุญาตการใช้กล้องในเบราว์เซอร์';
        captureButton.disabled = true;
        showModal('dashboardCameraModal');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            if (version !== cameraSessionVersion) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            cameraStream = stream;
            const video = document.getElementById('dashboardCameraStream');
            video.srcObject = stream;
            let timer;
            try {
                await Promise.race([
                    video.play(),
                    new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('camera-timeout')), 12000); }),
                ]);
            } finally { window.clearTimeout(timer); }
            if (version !== cameraSessionVersion) return;
            if (!video.videoWidth || !video.videoHeight) throw new Error('camera-not-ready');
            status.textContent = 'กล้องพร้อมแล้ว จัดรอยโรคให้อยู่กลางภาพ แล้วกดถ่ายภาพ';
            captureButton.disabled = false;
            captureButton.focus();
        } catch (error) {
            if (version !== cameraSessionVersion) return;
            stopCamera();
            status.textContent = error.name === 'NotAllowedError'
                ? 'ยังไม่ได้รับอนุญาตใช้กล้อง กรุณาอนุญาตในเบราว์เซอร์ หรือกดเปิดกล้องของอุปกรณ์แทน'
                : error.name === 'NotFoundError'
                    ? 'ไม่พบกล้องในอุปกรณ์นี้ คุณสามารถปิดหน้าต่างและเลือกไฟล์ภาพได้'
                    : 'เปิดกล้องไม่ได้ กล้องอาจถูกใช้งานอยู่ กรุณาลองใหม่หรือกดเปิดกล้องของอุปกรณ์แทน';
        }
    }

    async function takePhoto() {
        const video = document.getElementById('dashboardCameraStream');
        const canvas = document.getElementById('dashboardCameraCanvas');
        const button = document.getElementById('dashboardTakePhotoButton');
        if (button.disabled) return;
        if (!video.videoWidth || !video.videoHeight) {
            setStatus('กล้องยังไม่พร้อมถ่ายภาพ โปรดลองอีกครั้ง', 'error');
            return;
        }
        const version = cameraSessionVersion;
        button.disabled = true;
        try {
            const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
            if (version !== cameraSessionVersion) return;
            if (!blob) throw new Error('ไม่สามารถสร้างภาพจากกล้องได้ โปรดลองใหม่อีกครั้ง');
            const photo = new File([blob], `skin-photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
            const selected = await presentImage(photo, 'ถ่ายจากกล้อง', 'camera', () => version === cameraSessionVersion);
            if (selected) closeCamera();
        } catch (error) {
            if (version === cameraSessionVersion) setStatus(error.message || 'ไม่สามารถถ่ายภาพได้ กรุณาลองใหม่', 'error');
        } finally {
            canvas.width = canvas.height = 0;
            if (version === cameraSessionVersion) button.disabled = false;
        }
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
            appendAccountInfoSection(content, 'การเข้าถึงและผู้ให้บริการภายนอก', 'เมื่อกดสแกน ภาพที่ลบข้อมูลเมตาบนอุปกรณ์แล้วจะถูกส่งผ่าน HTTPS ไป Supabase ส่วนตัว ผ่านแบ็กเอนด์ Vercel และบริการโมเดล Smart Skin AI บนเซิร์ฟเวอร์ที่ผู้ดูแลได้รับสิทธิ์ใช้ บริการโมเดลประมวลผลในหน่วยความจำ ไม่บันทึกไฟล์และไม่ส่งภาพต่อ Google หรือ Hugging Face ภาพและผลที่ยอมรับเก็บใน Supabase สำหรับประวัติส่วนตัว ภาพที่ถูกปฏิเสธจะถูกลบ ไม่ใช้ภาพของคุณฝึกโมเดล ส่วน Open-Meteo ได้รับเฉพาะพิกัดโดยประมาณเมื่อคุณยินยอมใช้เรดาร์');
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
        if (sessionCheckPending) return;
        sessionCheckPending = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        document.getElementById('dashboardSessionError').classList.add('hidden');
        document.getElementById('dashboardSessionRetryButton').disabled = true;
        try {
            const response = await fetch('/api/account/me', { credentials: 'same-origin', signal: controller.signal });
            const data = await response.json().catch(() => ({}));
            if (response.status === 401 || response.status === 403) return window.location.replace('/?signin=1');
            if (!response.ok || !data.user) throw new Error('missing session');
            clearTimeout(timer);
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
                await refreshPrivateStorageStatus();
            }
            document.getElementById('dashboardLoading').classList.add('hidden');
            document.getElementById('dashboardMain').classList.remove('hidden');
        } catch {
            document.getElementById('dashboardLoading').classList.add('hidden');
            document.getElementById('dashboardSessionError').classList.remove('hidden');
        } finally {
            clearTimeout(timer);
            sessionCheckPending = false;
            document.getElementById('dashboardSessionRetryButton').disabled = false;
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
        document.getElementById('dashboardSessionRetryButton').addEventListener('click', requireSession);
        refreshIcons();
        const catalogue = document.getElementById('dashboardModelClassList');
        if (catalogue) void getScanResultModule().then(module => module.renderModelCatalogue(catalogue)).catch(() => {
            catalogue.textContent = 'ยังโหลดรายชื่อกลุ่มไม่ได้ กรุณาลองโหลดหน้าใหม่';
        });
        document.getElementById('dashboardImageInput').addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) presentImage(file, 'เลือกจากอุปกรณ์', 'upload');
        });
        document.getElementById('dashboardNativeCameraInput').addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) presentImage(file, 'ถ่ายจากกล้องของอุปกรณ์', 'camera');
        });
        document.getElementById('dashboardNativeCameraButton').addEventListener('click', () => {
            closeCamera();
            document.getElementById('dashboardNativeCameraInput').click();
        });
        document.getElementById('dashboardOpenCameraButton').addEventListener('click', openCamera);
        document.getElementById('dashboardClearImageButton').addEventListener('click', clearImage);
        document.getElementById('dashboardSubmitScanButton').addEventListener('click', submitPrivateScan);
        document.getElementById('dashboardAnalysisNewButton').addEventListener('click', returnToScan);
        document.getElementById('dashboardAnalysisHistoryButton').addEventListener('click', openTimeline);
        document.getElementById('dashboardCloseCameraButton').addEventListener('click', closeCamera);
        document.getElementById('dashboardCancelCameraButton').addEventListener('click', closeCamera);
        document.getElementById('dashboardTakePhotoButton').addEventListener('click', takePhoto);
        document.getElementById('dashboardLogoutButton').addEventListener('click', openLogoutModal);
        document.getElementById('menuLogoutButton').addEventListener('click', openLogoutModal);
        document.getElementById('dashboardLogoutCancelButton').addEventListener('click', closeLogoutModal);
        document.getElementById('dashboardLogoutConfirmButton').addEventListener('click', logout);
        document.getElementById('dashboardLogoutModal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeLogoutModal(); });
        document.getElementById('dashboardProcessingCloseButton').addEventListener('click', () => closeModal('dashboardProcessingModal'));
        document.getElementById('dashboardProcessingResultButton').addEventListener('click', openCompletedAnalysis);

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
            if (!document.getElementById('dashboardProcessingModal').classList.contains('hidden')) {
                if (event.key === 'Escape') event.preventDefault();
                if (event.key === 'Tab') {
                    event.preventDefault();
                    const target = document.getElementById('dashboardProcessingModal').dataset.processing === 'complete'
                        ? 'dashboardProcessingResultButton'
                        : document.getElementById('dashboardProcessingModal').dataset.processing === 'error'
                            ? 'dashboardProcessingCloseButton' : 'dashboardProcessingTitle';
                    document.getElementById(target).focus();
                }
                return;
            }
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
