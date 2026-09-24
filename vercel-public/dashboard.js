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

    function renderSystemAvatarIcon(element, size) {
        element.replaceChildren();
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', 'cross');
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
        description.textContent = 'หน้าแสกนปัจจุบันแสดงภาพบนอุปกรณ์และยังไม่บันทึกข้อมูลเข้าสู่ Timeline';
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
            document.getElementById('nearbyPm25').textContent = air.current?.pm2_5 === undefined ? '—' : Number(air.current.pm2_5).toFixed(1);
            document.getElementById('nearbyUv').textContent = weather.current?.uv_index === undefined ? '—' : Number(weather.current.uv_index).toFixed(1);
            document.getElementById('nearbyHumidity').textContent = weather.current?.relative_humidity_2m === undefined ? '—' : `${Math.round(weather.current.relative_humidity_2m)}%`;
            document.getElementById('nearbyTemperature').textContent = weather.current?.temperature_2m === undefined ? '—' : `${Number(weather.current.temperature_2m).toFixed(1)}°C`;
            document.getElementById('nearbyContextLevel').textContent = 'ข้อมูลสภาพแวดล้อมล่าสุด';
            document.getElementById('nearbyContextSummary').textContent = 'ใช้ประกอบการดูแลผิวทั่วไปเท่านั้น ไม่ใช่การระบุหรือวินิจฉัยความเสี่ยงโรคผิวหนัง';
            document.getElementById('nearbyContextLocation').textContent = `ข้อมูลล่าสุด ${formatDate(Date.now())} · พิกัดโดยประมาณ ${latitude.toFixed(2)}, ${longitude.toFixed(2)} · ไม่บันทึกในบัญชี`;
            setModalStatus('nearbyRadarStatus', 'ข้อมูลเรียกใช้ตามตำแหน่งปัจจุบันแบบครั้งเดียวและไม่ได้บันทึกพิกัดในบัญชี', 'success');
        } catch (error) {
            setModalStatus('nearbyRadarStatus', error.message, 'error');
        } finally {
            button.disabled = false;
            button.innerHTML = '<i data-lucide="locate-fixed" class="h-4 w-4"></i>ยินยอมและตรวจบริบทพื้นที่';
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
            appendAccountInfoSection(content, '3. ภาพและบัญชี', 'ส่งได้เฉพาะภาพผิวหนังที่คุณมีสิทธิ์ใช้ และควรปกปิดข้อมูลระบุตัวตนที่ไม่จำเป็น หน้าแสกนปัจจุบันแสดงภาพเป็นตัวอย่างบนอุปกรณ์และยังไม่อัปโหลดหรือบันทึกภาพเข้าสู่ระบบ');
            appendAccountInfoSection(content, '4. ข้อมูลส่วนบุคคล', 'คุณจัดการรูปโปรไฟล์ รหัสผ่าน ข้อความถึงผู้ดูแล และลบบัญชีได้จากเมนูบัญชีของคุณ ข้อมูลที่บันทึกจริงจะแสดงใน Timeline เท่านั้น');
            appendAccountInfoSection(content, '5. การเปลี่ยนแปลง', 'เมื่อเงื่อนไขหรือฟังก์ชันมีการเปลี่ยนแปลงอย่างมีนัยสำคัญ ระบบจะแจ้งให้ผู้ใช้ทราบก่อนใช้งานข้อมูลเพิ่มเติม');
        } else {
            kicker.textContent = 'SMART SKIN AI';
            title.textContent = 'ประกาศความเป็นส่วนตัวสำหรับการสแกนภาพ';
            description.textContent = 'ระบบนี้ใช้ข้อมูลเพื่อช่วยการดูแลผิวทั่วไป ไม่ใช่การวินิจฉัยโรคหรือบริการรักษาพยาบาล';
            appendAccountInfoSection(content, 'ผู้ควบคุมข้อมูลและการติดต่อ', 'หากต้องการแจ้งปัญหาหรือใช้สิทธิเกี่ยวกับบัญชี ให้ส่งข้อความถึงผู้ดูแลผ่านเมนูบัญชีผู้ใช้');
            appendAccountInfoSection(content, 'ข้อมูลที่จัดเก็บ', 'รูปที่เลือกหรือถ่ายบนหน้าแสกนปัจจุบันอยู่บนอุปกรณ์และไม่ถูกส่งเข้าระบบ รูปโปรไฟล์ที่คุณบันทึก ข้อความที่ส่งถึงผู้ดูแล และข้อมูลประวัติที่ระบบตั้งค่าให้บันทึกเป็นข้อมูลของบัญชี');
            appendAccountInfoSection(content, 'รูปโปรไฟล์ (ไม่บังคับ)', 'รูปโปรไฟล์ใช้แสดงในเมนูบัญชีเท่านั้น ไม่ใช้เพื่อคัดกรองผิวหนัง คุณเปลี่ยนหรือลบได้ทุกเมื่อ และระบบจะลบเมื่อปิดบัญชี');
            appendAccountInfoSection(content, 'วัตถุประสงค์และการเข้าถึง', 'ผู้ดูแลระบบเห็นข้อมูลบัญชีที่จำเป็นต่อการจัดการสิทธิ์ และข้อความที่ผู้ใช้เลือกส่งให้เท่านั้น ไม่มีการแสดงรหัสผ่าน');
            appendAccountInfoSection(content, 'การลบข้อมูล', 'คุณลบรูปโปรไฟล์และลบบัญชีพร้อมข้อมูลที่เกี่ยวข้องได้จากเมนูบัญชี การลบบัญชีเป็นการดำเนินการถาวร');
            appendAccountInfoSection(content, 'ตำแหน่งและบริการภายนอก', 'ระบบไม่ขอตำแหน่งโดยอัตโนมัติ เรดาร์สภาพแวดล้อมจะทำงานเมื่อคุณยินยอม และส่งพิกัดโดยประมาณให้ Open-Meteo เพื่อเรียกข้อมูลอากาศครั้งเดียว โดยไม่บันทึกพิกัดไว้ในบัญชี');
            appendAccountInfoSection(content, 'ข้อควรระวังด้านสุขภาพ', 'หากรอยโรคเปลี่ยนแปลงเร็ว มีเลือดออก แผลไม่หาย ปวดมาก มีไข้ หรือผื่นลามเร็ว ให้พบแพทย์ผิวหนังหรือบริการฉุกเฉินในพื้นที่ทันที');
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
                document.getElementById('dashboardLogoutButton').classList.remove('hidden');
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
