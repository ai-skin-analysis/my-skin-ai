// Keep modal behavior consistent for keyboard and screen-reader users.
        // The page never stores a previous focus target beyond this browser tab.
        const modalFocusRestore = new Map();
        function getOpenAccessibleModal() {
            return [...document.querySelectorAll('[data-accessible-modal="true"]')]
                .filter((modal) => !modal.classList.contains('hidden'))
                .at(-1) || null;
        }
        function getFocusableElements(container) {
            return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter((element) => !element.closest('[hidden], .hidden'));
        }
        function syncAccessibleModalPageState() {
            const hasOpenModal = Boolean(getOpenAccessibleModal());
            document.documentElement.classList.toggle('overflow-hidden', hasOpenModal);
            document.body.classList.toggle('overflow-hidden', hasOpenModal);
        }
        function showAccessibleModal(modalId, initialFocusSelector = '') {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            if (modal.classList.contains('hidden')) {
                modalFocusRestore.set(modalId, document.activeElement instanceof HTMLElement ? document.activeElement : null);
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            modal.setAttribute('aria-hidden', 'false');
            syncAccessibleModalPageState();
            window.setTimeout(() => {
                const initial = initialFocusSelector ? modal.querySelector(initialFocusSelector) : null;
                const target = initial || getFocusableElements(modal)[0];
                if (target instanceof HTMLElement) target.focus();
            }, 0);
        }
        function hideAccessibleModal(modalId) {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.setAttribute('aria-hidden', 'true');
            syncAccessibleModalPageState();
            const restoreTarget = modalFocusRestore.get(modalId);
            modalFocusRestore.delete(modalId);
            if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) {
                window.setTimeout(() => restoreTarget.focus(), 0);
            }
        }
        document.addEventListener('keydown', (event) => {
            const modal = getOpenAccessibleModal();
            if (!modal) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                const closeButton = modal.querySelector('[data-modal-close]');
                if (closeButton instanceof HTMLElement) closeButton.click();
                else hideAccessibleModal(modal.id);
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = getFocusableElements(modal);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        const eilikContainer = document.getElementById('eilik-space-container');
        const eilikRender = document.getElementById('eilik-render');
        const eilikLeftArm = document.getElementById('eilik-left-arm');
        const eilikRightArm = document.getElementById('eilik-right-arm');
        const eilikFloorShadow = document.getElementById('eilik-floor-shadow');
        const eilikSpeech = document.getElementById('eilik-speech');
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const eilikPhrases = [
            'ระบบข้อมูลพร้อมแล้ว คุณสามารถดูข้อมูลสภาพอากาศประกอบการดูแลผิวได้ครับ',
            'ผิวดีเริ่มจากการสังเกตอาการ หากกังวลควรพบแพทย์ผิวหนังนะครับ',
            'พร้อมช่วยแนะนำขั้นตอนการใช้ระบบอย่างปลอดภัยครับ',
            'รุ่นสาธิตใช้โมเดลเดิม 1 ตัวสำหรับ 3 กลุ่ม: สิว สะเก็ดเงิน และลมพิษ บัญชีที่ผู้ดูแลอนุมัติทดลองได้เมื่อบริการพร้อมและยินยอมส่งภาพ ผลอาจผิดพลาดและไม่ใช่การวินิจฉัยครับ',
            'ข้อมูลในเว็บไซต์ไม่ใช่การวินิจฉัยหรือการรักษาพยาบาลครับ'
        ];

        function clearEilikAnimations() {
            eilikRender.classList.remove('eilik-state-float', 'eilik-state-walk', 'eilik-state-jump', 'eilik-state-spin');
            eilikLeftArm.classList.remove('eilik-arm-left-up');
            eilikRightArm.classList.remove('eilik-arm-right-up', 'eilik-arm-right-wave');
        }

        function roamEilikEverywhere() {
            if (reduceMotion || eilikRender.classList.contains('eilik-state-jump') || eilikRender.classList.contains('eilik-state-spin') || eilikRightArm.classList.contains('eilik-arm-right-wave')) return;

            const robotWidth = Math.min(240, Math.max(170, window.innerWidth * 0.26));
            const maxX = Math.max(20, window.innerWidth - robotWidth - 20);
            const maxY = Math.max(110, window.innerHeight - 250);
            const randomX = Math.floor(Math.random() * maxX) + 10;
            const randomY = Math.floor(Math.random() * (maxY - 80)) + 80;
            const currentX = parseInt(eilikContainer.style.left, 10) || 0;
            const distance = Math.abs(randomX - currentX);

            clearEilikAnimations();
            eilikRender.classList.add(distance > 300 ? 'eilik-state-walk' : 'eilik-state-float');
            eilikContainer.style.transitionDuration = distance > 300 ? '2500ms' : '3500ms';
            eilikFloorShadow.style.transform = distance > 300 ? 'scale(.6)' : 'scale(1)';
            eilikSpeech.textContent = eilikPhrases[Math.floor(Math.random() * eilikPhrases.length)];
            eilikContainer.style.left = `${randomX}px`;
            eilikContainer.style.top = `${randomY}px`;
        }

        function resetEilikToNormal() {
            clearEilikAnimations();
            eilikRender.classList.add('eilik-state-float');
            roamEilikEverywhere();
        }

        function welcomeEilik() {
            clearEilikAnimations();
            eilikRender.classList.add('eilik-state-float');
            eilikRightArm.classList.add('eilik-arm-right-wave');
            eilikSpeech.textContent = 'สวัสดีครับ! ผมอิลลิค ผู้ช่วย AI ยินดีต้อนรับสู่ Smart Skin AI ครับ';
            if (!reduceMotion) {
                window.setTimeout(() => {
                    eilikRightArm.classList.remove('eilik-arm-right-wave');
                    roamEilikEverywhere();
                    window.setInterval(roamEilikEverywhere, 7000);
                }, 4000);
            }
        }

        eilikRender.addEventListener('click', () => {
            if (reduceMotion) {
                eilikSpeech.textContent = 'สวัสดีครับ ผมอิลลิค พร้อมช่วยแนะนำการใช้งานระบบครับ';
                return;
            }
            clearEilikAnimations();
            const actions = ['greet', 'spin', 'jump'];
            const action = actions[Math.floor(Math.random() * actions.length)];
            if (action === 'greet') {
                eilikRightArm.classList.add('eilik-arm-right-wave');
                eilikSpeech.textContent = 'สวัสดีครับ! ถ้ามีอาการน่ากังวลหรือเปลี่ยนแปลงเร็ว ควรพบแพทย์ผิวหนังนะครับ';
                window.setTimeout(resetEilikToNormal, 2500);
            } else if (action === 'spin') {
                eilikRender.classList.add('eilik-state-spin');
                eilikSpeech.textContent = 'ว้าว! พร้อมเริ่มต้นดูแลผิวอย่างรอบคอบแล้วครับ';
                window.setTimeout(resetEilikToNormal, 1000);
            } else {
                eilikRender.classList.add('eilik-state-jump');
                eilikLeftArm.classList.add('eilik-arm-left-up');
                eilikRightArm.classList.add('eilik-arm-right-up');
                eilikSpeech.textContent = 'เยี่ยมเลย! เลือกดูข้อมูลที่ต้องการ และหากกังวลเรื่องผิวหนังควรพบแพทย์นะครับ';
                window.setTimeout(resetEilikToNormal, 2500);
            }
        });

        window.setTimeout(welcomeEilik, 900);

        let currentLat = null;
        let currentLng = null;
        let environmentLocationConsent = false;
        let environmentRequestId = 0;
        let environmentRequestBusy = false;
        let environmentController = null;
        let environmentSelectedArea = null;
        let environmentAreaSearchId = 0;
        let environmentAreaSearchController = null;
        let mapLocationRequestId = 0;
        let mapLocationDeadline = null;
        let mapLocationConsent = false;
        // This is a separate, one-time approval for a Google Maps URL that
        // contains coordinates. A later checkbox tick alone is not enough to
        // reuse a position acquired for OpenStreetMap.
        let mapGoogleMapsLocationConsent = false;
        let lastMapQuery = 'คลินิกหมอผิวหนัง';
        let currentLocationMeta = {
            capturedAt: null,
            accuracyMeters: null,
            approximateName: '',
        };
        let mapFrameIsExternal = false;

        let liveEnvData = {
            uv: { val: '—', status: "รออนุญาตตำแหน่ง", title: "UV Index (ดัชนีรังสีอุลตราไวโอเลต)", badge: "", badgeClass: "", iconBg: "bg-amber-100 text-amber-600", icon: "sun", desc: "ยืนยันการใช้ตำแหน่งก่อนเรียกข้อมูลปัจจุบัน" },
            temp: { val: '—', status: "รออนุญาตตำแหน่ง", title: "อุณหภูมิอากาศ (Temperature)", badge: "", badgeClass: "", iconBg: "bg-orange-100 text-orange-600", icon: "thermometer", desc: "ยืนยันการใช้ตำแหน่งก่อนเรียกข้อมูลปัจจุบัน" },
            humidity: { val: '—', status: "รออนุญาตตำแหน่ง", title: "ความชื้นสัมพัทธ์ (Humidity)", badge: "", badgeClass: "", iconBg: "bg-blue-100 text-blue-600", icon: "droplets", desc: "ยืนยันการใช้ตำแหน่งก่อนเรียกข้อมูลปัจจุบัน" },
            aqi: { val: '—', status: "รออนุญาตตำแหน่ง", title: "ดัชนีคุณภาพอากาศ (AQI)", badge: "", badgeClass: "", iconBg: "bg-emerald-100 text-emerald-600", icon: "wind", desc: "ยืนยันการใช้ตำแหน่งก่อนเรียกข้อมูลปัจจุบัน" }
        };
        let localPreviewUrl = '';
        let localCameraStream = null;

        document.addEventListener("DOMContentLoaded", () => {
            // Public weather controls must work before and independently of
            // account restoration. CSP intentionally blocks inline onclick.
            setupPublicEnvironmentControls();
            setupPublicMedicalMapControls();
            if (typeof lucide !== 'undefined') lucide.createIcons();
            // Bind the account-panel interactions explicitly. Inline handlers
            // are not dependable under every static-host security policy.
            document.getElementById('btnTabLogin')?.addEventListener('click', () => switchForm('login'));
            document.getElementById('btnTabRegister')?.addEventListener('click', () => switchForm('register'));
            document.getElementById('formLogin')?.addEventListener('submit', submitAccountForm);
            document.getElementById('formRegister')?.addEventListener('submit', submitAccountForm);
            document.getElementById('logoutButton')?.addEventListener('click', openAccountLogoutModal);
            document.getElementById('accountLogoutCancelButton')?.addEventListener('click', closeAccountLogoutModal);
            document.getElementById('accountLogoutConfirmButton')?.addEventListener('click', logoutAccount);
            document.getElementById('accountLogoutModal')?.addEventListener('click', (event) => {
                if (event.target === event.currentTarget) closeAccountLogoutModal();
            });
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && !document.getElementById('accountLogoutModal')?.classList.contains('hidden')) closeAccountLogoutModal();
            });
            restoreAccountSession();
        });

        function setupPublicEnvironmentControls() {
            document.getElementById('environmentLocationButton')?.addEventListener('click', useCurrentLocationForEnvironment);
            document.getElementById('environmentRefreshButton')?.addEventListener('click', refreshEnvironmentData);
            document.getElementById('environmentLocationConfirmButton')?.addEventListener('click', approveEnvironmentLocationConsent);
            document.getElementById('environmentAreaButton')?.addEventListener('click', openEnvironmentArea);
            document.getElementById('environmentAreaForm')?.addEventListener('submit', searchEnvironmentAreas);
            document.querySelectorAll('[data-close-environment-area]').forEach((button) => button.addEventListener('click', closeEnvironmentArea));
            document.getElementById('environmentAreaModal')?.addEventListener('click', (event) => {
                if (event.target === event.currentTarget) closeEnvironmentArea();
            });
            document.querySelectorAll('[data-close-environment-consent]').forEach((button) => {
                button.addEventListener('click', closeEnvironmentLocationConsent);
            });
            document.getElementById('environmentLocationConsentModal')?.addEventListener('click', (event) => {
                if (event.target === event.currentTarget) closeEnvironmentLocationConsent();
            });
            document.querySelectorAll('[data-environment-detail]').forEach((card) => {
                const open = () => openEnvDetailModal(card.dataset.environmentDetail);
                card.addEventListener('click', open);
                card.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open();
                    }
                });
            });
            document.querySelectorAll('[data-close-environment-detail]').forEach((button) => {
                button.addEventListener('click', closeEnvDetailModal);
            });
        }

        function setupPublicMedicalMapControls() {
            document.getElementById('medicalMapButton')?.addEventListener('click', () => openMapModal());
            document.getElementById('medicalMapSearchButton')?.addEventListener('click', executeCustomSearch);
            document.getElementById('customSearchInput')?.addEventListener('keydown', handleSearchKeyPress);
            document.getElementById('mapLocationButton')?.addEventListener('click', useCurrentLocationForMap);
            document.querySelectorAll('[data-map-category]').forEach((button) => {
                button.addEventListener('click', () => filterMapSearch(button.dataset.mapCategory));
            });
            document.querySelectorAll('[data-close-medical-map]').forEach((button) => button.addEventListener('click', closeMapModal));
            document.getElementById('mapModal')?.addEventListener('click', (event) => {
                if (event.target === event.currentTarget) closeMapModal();
            });
            document.getElementById('googleMapIframe')?.addEventListener('error', () => {
                if (mapFrameIsExternal) showMapFrameFallback('แผนที่ฝังโหลดไม่ได้ กรุณากดเปิดผลค้นหาใน Google Maps ด้านบน');
            });
        }

        function openEnvironmentArea() {
            if (environmentRequestBusy) return;
            document.getElementById('environmentAreaStatus').textContent = 'พิมพ์ชื่อเมืองหรือจังหวัด แล้วเลือกผลลัพธ์ที่ต้องการ';
            document.getElementById('environmentAreaResults').replaceChildren();
            showAccessibleModal('environmentAreaModal', '#environmentAreaInput');
        }

        function closeEnvironmentArea() {
            ++environmentAreaSearchId;
            environmentAreaSearchController?.abort();
            document.getElementById('environmentAreaSearchButton').disabled = false;
            hideAccessibleModal('environmentAreaModal');
        }

        async function searchEnvironmentAreas(event) {
            event?.preventDefault();
            const query = document.getElementById('environmentAreaInput').value.trim();
            const status = document.getElementById('environmentAreaStatus');
            const results = document.getElementById('environmentAreaResults');
            if (query.length < 2 || query.length > 80) {
                status.textContent = 'กรุณาพิมพ์ชื่อเมืองหรือจังหวัด 2–80 ตัวอักษร';
                return;
            }
            const searchId = ++environmentAreaSearchId;
            environmentAreaSearchController?.abort();
            environmentAreaSearchController = new AbortController();
            const searchButton = document.getElementById('environmentAreaSearchButton');
            searchButton.disabled = true;
            status.textContent = 'กำลังค้นหาพื้นที่…';
            results.replaceChildren();
            try {
                const data = await fetchEnvironmentJson('/api/environment', 8000, environmentAreaSearchController.signal, { kind: 'places', query });
                if (searchId !== environmentAreaSearchId) return;
                const places = Array.isArray(data.results) ? data.results.filter(validEnvironmentArea).slice(0, 8) : [];
                status.textContent = places.length ? 'เลือกพื้นที่เพื่อดูอากาศปัจจุบัน (ไม่ใช้ GPS)' : 'ไม่พบพื้นที่ ลองชื่อจังหวัดหรือชื่อภาษาอังกฤษ เช่น Bangkok';
                for (const place of places) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'w-full rounded-xl border border-teal-200 bg-teal-50 p-3 text-left text-sm font-bold text-teal-900 hover:bg-teal-100';
                    button.textContent = environmentAreaLabel(place);
                    button.addEventListener('click', () => {
                        closeEnvironmentArea();
                        requestSelectedAreaWeather(place);
                    });
                    results.append(button);
                }
            } catch (error) {
                if (searchId === environmentAreaSearchId) status.textContent = 'ค้นหาพื้นที่ไม่สำเร็จ โปรดตรวจอินเทอร์เน็ตแล้วลองใหม่';
            } finally {
                if (searchId === environmentAreaSearchId) searchButton.disabled = false;
            }
        }

        function validEnvironmentArea(place) {
            return place && typeof place.name === 'string' && place.name.trim()
                && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
                && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180;
        }

        function environmentAreaLabel(place) {
            return [place.name, place.admin1, place.country].filter(value => typeof value === 'string' && value)
                .filter((value, index, parts) => parts.indexOf(value) === index).join(' · ');
        }

        async function requestSelectedAreaWeather(place) {
            if (environmentRequestBusy || !validEnvironmentArea(place)) return;
            environmentSelectedArea = { ...place };
            const requestId = ++environmentRequestId;
            environmentController?.abort();
            environmentController = new AbortController();
            setEnvironmentBusy(true);
            resetEnvironmentCards('กำลังโหลดอากาศของพื้นที่');
            document.getElementById('location-text').textContent = 'กำลังโหลดอากาศ…';
            document.getElementById('environment-area-text').textContent = `พื้นที่ที่เลือก: ${environmentAreaLabel(place)} — ไม่ใช่ตำแหน่ง GPS ของอุปกรณ์`;
            document.getElementById('environment-current-weather').textContent = 'กำลังโหลดสภาพอากาศปัจจุบัน';
            setEnvironmentSourceText('เรียกอากาศของพื้นที่ที่คุณเลือก โดยไม่ขอสิทธิ์ตำแหน่ง', 'พิกัดเป็นจุดอ้างอิงของเมืองหรือพื้นที่ ไม่ใช่ตำแหน่งจริงของคุณ');
            try {
                await fetchLiveWeatherData(place.latitude, place.longitude, { source: 'selected-area', approximateName: environmentAreaLabel(place) }, requestId, environmentController.signal);
            } finally {
                if (requestId === environmentRequestId) setEnvironmentBusy(false);
            }
        }

        function setupLocalImageCapture() {
            document.getElementById('localImageInput')?.addEventListener('change', handleLocalImageSelection);
            document.getElementById('openLocalCameraButton')?.addEventListener('click', openLocalCamera);
            document.getElementById('clearLocalImageButton')?.addEventListener('click', clearLocalImagePreview);
            document.getElementById('closeLocalCameraButton')?.addEventListener('click', closeLocalCamera);
            document.getElementById('cancelLocalCameraButton')?.addEventListener('click', closeLocalCamera);
            document.getElementById('takeLocalPhotoButton')?.addEventListener('click', takeLocalPhoto);
            window.addEventListener('pagehide', stopLocalCameraTracks);
        }

        function setLocalImageStatus(message, tone = 'info') {
            const status = document.getElementById('localImageStatus');
            if (!status) return;
            const tones = {
                info: 'mt-3 text-xs leading-relaxed text-amber-950',
                success: 'mt-3 text-xs leading-relaxed font-semibold text-teal-800',
                error: 'mt-3 text-xs leading-relaxed font-semibold text-rose-700',
            };
            status.className = tones[tone] || tones.info;
            status.textContent = message;
        }

        function formatLocalImageSize(bytes) {
            if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }

        function validateLocalImage(file) {
            const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
            if (!file || !allowedTypes.has(file.type)) {
                setLocalImageStatus('กรุณาเลือกภาพ JPG, JPEG, PNG หรือ WEBP เท่านั้น', 'error');
                return false;
            }
            if (!file.size || file.size > 8 * 1024 * 1024) {
                setLocalImageStatus('ภาพต้องมีขนาดไม่เกิน 8 MB กรุณาเลือกไฟล์ที่เล็กลง', 'error');
                return false;
            }
            return true;
        }

        function presentLocalImage(file, sourceLabel) {
            if (!validateLocalImage(file)) return;
            if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
            localPreviewUrl = URL.createObjectURL(file);
            const preview = document.getElementById('localImagePreview');
            const placeholder = document.getElementById('imageCapturePlaceholder');
            const panel = document.getElementById('localImagePreviewPanel');
            const meta = document.getElementById('localImageFileMeta');
            if (!preview || !placeholder || !panel || !meta) return;
            preview.src = localPreviewUrl;
            meta.textContent = `${sourceLabel}: ${file.name} · ${formatLocalImageSize(file.size)}`;
            placeholder.classList.add('hidden');
            panel.classList.remove('hidden');
            setLocalImageStatus('ภาพพร้อมสำหรับดูตัวอย่างบนอุปกรณ์นี้เท่านั้น ภาพไม่ได้ถูกอัปโหลด จัดเก็บ หรือส่งให้ผู้ดูแลระบบ', 'success');
        }

        function handleLocalImageSelection(event) {
            const file = event.target.files?.[0];
            if (file) presentLocalImage(file, 'เลือกจากอุปกรณ์');
        }

        function clearLocalImagePreview() {
            const input = document.getElementById('localImageInput');
            const preview = document.getElementById('localImagePreview');
            const placeholder = document.getElementById('imageCapturePlaceholder');
            const panel = document.getElementById('localImagePreviewPanel');
            if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
            localPreviewUrl = '';
            if (input) input.value = '';
            if (preview) preview.removeAttribute('src');
            placeholder?.classList.remove('hidden');
            panel?.classList.add('hidden');
            setLocalImageStatus('ล้างภาพจากหน้าปัจจุบันแล้ว ไม่มีภาพถูกเก็บหรือส่งออกจากอุปกรณ์', 'info');
        }

        function stopLocalCameraTracks() {
            if (localCameraStream) {
                localCameraStream.getTracks().forEach((track) => track.stop());
                localCameraStream = null;
            }
            const video = document.getElementById('localCameraStream');
            if (video) video.srcObject = null;
        }

        async function openLocalCamera() {
            if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
                setLocalImageStatus('ไม่สามารถใช้กล้องได้ โปรดเปิดผ่าน HTTPS บนอุปกรณ์ที่รองรับกล้อง', 'error');
                return;
            }
            try {
                localCameraStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false,
                });
                const video = document.getElementById('localCameraStream');
                if (!video) {
                    stopLocalCameraTracks();
                    return;
                }
                video.srcObject = localCameraStream;
                showAccessibleModal('localCameraModal', '#takeLocalPhotoButton');
                if (typeof lucide !== 'undefined') lucide.createIcons();
            } catch (error) {
                stopLocalCameraTracks();
                setLocalImageStatus('ไม่สามารถเปิดกล้องได้ โปรดอนุญาตการใช้กล้องในเบราว์เซอร์ แล้วลองใหม่อีกครั้ง', 'error');
            }
        }

        function closeLocalCamera() {
            stopLocalCameraTracks();
            hideAccessibleModal('localCameraModal');
        }

        function takeLocalPhoto() {
            const video = document.getElementById('localCameraStream');
            const canvas = document.getElementById('localCameraCanvas');
            if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
                setLocalImageStatus('กล้องยังไม่พร้อมถ่ายภาพ โปรดลองอีกครั้ง', 'error');
                return;
            }
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
                if (!blob) {
                    setLocalImageStatus('ไม่สามารถสร้างภาพจากกล้องได้ โปรดลองใหม่อีกครั้ง', 'error');
                    return;
                }
                const photo = new File([blob], `skin-photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
                const input = document.getElementById('localImageInput');
                if (input && typeof DataTransfer !== 'undefined') {
                    const transfer = new DataTransfer();
                    transfer.items.add(photo);
                    input.files = transfer.files;
                }
                presentLocalImage(photo, 'ถ่ายจากกล้อง');
                closeLocalCamera();
            }, 'image/jpeg', 0.92);
        }

        function openEnvironmentLocationConsent() {
            document.getElementById('environmentLocationConsentCheck').checked = false;
            document.getElementById('environmentLocationConsentStatus').textContent = '';
            showAccessibleModal('environmentLocationConsentModal', '#environmentLocationConsentCheck');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function closeEnvironmentLocationConsent() {
            hideAccessibleModal('environmentLocationConsentModal');
        }

        function insecureLocationContextMessage() {
            return 'ไม่สามารถใช้ตำแหน่งจากลิงก์ HTTP/IP ได้ — โปรดเปิดเว็บผ่าน HTTPS ที่มีใบรับรองเชื่อถือได้ หรือทดสอบบนเครื่องนี้ที่ http://127.0.0.1:5000';
        }

        function locationErrorMessage(error) {
            if (!window.isSecureContext) return insecureLocationContextMessage();
            if (error?.code === 1) return 'เบราว์เซอร์ไม่ได้ให้สิทธิ์ตำแหน่ง — กด “เลือกพื้นที่เอง” เพื่อดูอากาศได้เลย หรือเปิดสิทธิ์ Location ของเว็บไซต์แล้วลองใหม่';
            if (error?.code === 2) return 'อุปกรณ์ยังไม่ส่งตำแหน่ง โปรดเปิดบริการตำแหน่ง (Location/GPS) และ Wi-Fi หรืออินเทอร์เน็ต แล้วลองอีกครั้ง';
            if (error?.code === 3) return 'อุปกรณ์ยังหาตำแหน่งไม่สำเร็จ โปรดอนุญาต Location ให้เบราว์เซอร์ เปิดบริการตำแหน่งและ Wi-Fi แล้วลองอีกครั้ง';
            return 'ไม่สามารถระบุตำแหน่งได้ในขณะนี้';
        }

        function hasCurrentLocation() {
            return Number.isFinite(currentLat) && Number.isFinite(currentLng);
        }

        function saveFreshBrowserLocation(position) {
            currentLat = position.coords.latitude;
            currentLng = position.coords.longitude;
            currentLocationMeta = {
                capturedAt: Number(position.timestamp) || Date.now(),
                accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
                approximateName: '',
            };
        }

        function roundedCoordinate(value) {
            return Number(Number(value).toFixed(4));
        }

        function setEnvironmentSourceText(text, note = '') {
            const source = document.getElementById('environment-source-text');
            const sourceNote = document.getElementById('environment-source-note');
            if (source) source.textContent = text;
            if (sourceNote && note) sourceNote.textContent = note;
        }

        function setMapLocationStatus(text, isError = false) {
            const status = document.getElementById('mapLocationStatus');
            if (!status) return;
            status.textContent = text;
            status.className = `min-h-4 text-[11px] font-semibold ${isError ? 'text-rose-600' : 'text-teal-700'}`;
        }

        function showMapFrameFallback(text) {
            const frame = document.getElementById('googleMapIframe');
            const fallback = document.getElementById('mapFrameFallback');
            const fallbackText = document.getElementById('mapFrameFallbackText');
            mapFrameIsExternal = false;
            frame.src = '';
            fallbackText.textContent = text;
            fallback.classList.remove('hidden');
            fallback.classList.add('flex');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function loadMapFrame(url) {
            const frame = document.getElementById('googleMapIframe');
            const fallback = document.getElementById('mapFrameFallback');
            mapFrameIsExternal = true;
            fallback.classList.add('hidden');
            fallback.classList.remove('flex');
            frame.src = url;
        }

        function useCurrentLocationForEnvironment() {
            if (environmentRequestBusy) return;
            if (!window.isSecureContext) {
                showEnvironmentUnavailable(insecureLocationContextMessage());
                return;
            }
            if (!navigator.geolocation) {
                showEnvironmentUnavailable('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
                return;
            }
            openEnvironmentLocationConsent();
        }

        function approveEnvironmentLocationConsent() {
            const status = document.getElementById('environmentLocationConsentStatus');
            if (!document.getElementById('environmentLocationConsentCheck').checked) {
                status.textContent = 'โปรดยืนยันความเข้าใจก่อนขอตำแหน่งจากเบราว์เซอร์';
                return;
            }
            if (!window.isSecureContext) {
                status.textContent = insecureLocationContextMessage();
                return;
            }
            if (!navigator.geolocation) {
                status.textContent = 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง';
                return;
            }
            closeEnvironmentLocationConsent();
            environmentLocationConsent = true;
            requestFreshEnvironmentLocation();
        }

        function refreshEnvironmentData() {
            if (environmentRequestBusy) return;
            if (environmentSelectedArea) {
                requestSelectedAreaWeather(environmentSelectedArea);
                return;
            }
            if (!environmentLocationConsent || !hasCurrentLocation()) {
                useCurrentLocationForEnvironment();
                return;
            }
            if (!window.isSecureContext || !navigator.geolocation) {
                showEnvironmentUnavailable(!window.isSecureContext
                    ? insecureLocationContextMessage()
                    : 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
                return;
            }
            requestFreshEnvironmentLocation();
        }

        function setEnvironmentBusy(busy) {
            environmentRequestBusy = busy;
            ['environmentLocationButton', 'environmentRefreshButton', 'environmentAreaButton'].forEach((id) => {
                const button = document.getElementById(id);
                if (button) {
                    button.disabled = busy;
                    button.setAttribute('aria-busy', String(busy));
                }
            });
            document.getElementById('location-text').textContent = busy ? 'กำลังขอตำแหน่ง…' : 'ใช้ตำแหน่งล่าสุดของฉัน';
        }

        function resetEnvironmentCards(status) {
            ['uv', 'temp', 'humidity', 'aqi'].forEach((key) => {
                document.getElementById(`card-${key}-val`).textContent = '—';
                const statusNode = document.getElementById(`card-${key}-status`);
                statusNode.textContent = status;
                statusNode.className = 'inline-block px-2.5 py-0.5 text-xs font-bold rounded-full';
                liveEnvData[key] = { ...liveEnvData[key], val: '—', status, badge: status, desc: 'ยังไม่มีข้อมูลปัจจุบันจากผู้ให้บริการสำหรับตำแหน่งนี้' };
            });
            document.getElementById('time-period-text').textContent = 'รอข้อมูลอากาศ';
            ['rec-1', 'rec-2', 'rec-3', 'rec-4'].forEach((id) => {
                document.getElementById(id).textContent = 'คำแนะนำตามสภาพอากาศจะแสดงเมื่อได้รับข้อมูล';
            });
        }

        function requestFreshEnvironmentLocation() {
            if (environmentRequestBusy || !environmentLocationConsent) return;
            environmentSelectedArea = null;
            const requestId = ++environmentRequestId;
            environmentController?.abort();
            environmentController = new AbortController();
            const signal = environmentController.signal;
            setEnvironmentBusy(true);
            resetEnvironmentCards('รอตำแหน่งจากอุปกรณ์');
            document.getElementById('environment-area-text').textContent = 'กำลังขอตำแหน่งปัจจุบันจากอุปกรณ์ของคุณ';
            document.getElementById('environment-current-weather').textContent = 'สภาพอากาศปัจจุบัน';
            document.getElementById('env-summary-text').textContent = 'เมื่อได้รับตำแหน่ง ระบบจะเรียกข้อมูลอากาศปัจจุบันให้ทันที โดยไม่ต้องเข้าสู่ระบบ';
            setEnvironmentSourceText('โปรดกดอนุญาตตำแหน่งในหน้าต่างของเบราว์เซอร์ หากมีการถาม', 'ขอตำแหน่งใหม่ทุกครั้ง ไม่ใช้พิกัดเก่า ไม่ใช้ IP เดาตำแหน่ง และไม่บันทึกในบัญชี');

            let finished = false;
            let attempt = 0;
            const isActive = () => !finished && requestId === environmentRequestId && !signal.aborted;
            const helpTimer = window.setTimeout(() => {
                if (isActive()) setEnvironmentSourceText('ยังรอตำแหน่งจากอุปกรณ์ — ตรวจว่าได้กดอนุญาต Location ในเบราว์เซอร์แล้ว', 'เปิดบริการตำแหน่ง (Location/GPS) และ Wi-Fi บนอุปกรณ์ หากยังไม่พบตำแหน่ง ระบบจะลองวิธีระบุตำแหน่งสำรองให้อีกครั้ง');
            }, 5000);
            // Browser timeouts can exclude the permission prompt. Bound our UI
            // wait too; late callbacks must never send a cancelled position.
            const deadline = window.setTimeout(() => fail({ code: 3 }), 30000);
            const clearTimers = () => { window.clearTimeout(helpTimer); window.clearTimeout(deadline); };
            const fail = (error) => {
                if (!isActive()) return;
                finished = true;
                clearTimers();
                environmentController.abort();
                showEnvironmentUnavailable(locationErrorMessage(error));
                setEnvironmentBusy(false);
            };
            const acquire = (highAccuracy) => {
                const thisAttempt = ++attempt;
                const success = async (position) => {
                    if (!isActive() || thisAttempt !== attempt) return;
                    const { latitude, longitude } = position?.coords || {};
                    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
                        fail({ code: 2 });
                        return;
                    }
                    finished = true;
                    clearTimers();
                    saveFreshBrowserLocation(position);
                    document.getElementById('location-text').textContent = 'กำลังโหลดอากาศ…';
                    setEnvironmentSourceText('ได้รับตำแหน่งแล้ว กำลังโหลดสภาพอากาศปัจจุบัน', 'อากาศจะแสดงก่อน โดยไม่ต้องรอชื่อพื้นที่หรือคุณภาพอากาศ');
                    await fetchLiveWeatherData(currentLat, currentLng, { ...currentLocationMeta }, requestId, signal);
                    if (requestId === environmentRequestId) setEnvironmentBusy(false);
                };
                const error = (problem) => {
                    if (!isActive() || thisAttempt !== attempt) return;
                    if (!highAccuracy && (problem?.code === 2 || problem?.code === 3)) {
                        setEnvironmentSourceText('กำลังลองระบุตำแหน่งด้วย GPS อีกครั้ง', 'โปรดเปิดบริการตำแหน่งและอยู่ในจุดที่รับสัญญาณได้ ระบบยังไม่ส่งพิกัดจนกว่าอุปกรณ์จะระบุตำแหน่งสำเร็จ');
                        acquire(true);
                    } else fail(problem);
                };
                try {
                    // Weather grids do not require a precise GPS fix. Try the
                    // faster device/Wi-Fi reading first; both attempts are fresh.
                    navigator.geolocation.getCurrentPosition(success, error, {
                        enableHighAccuracy: highAccuracy, timeout: highAccuracy ? 10000 : 6000, maximumAge: 0,
                    });
                } catch (problem) { error(problem); }
            };
            acquire(false);
        }

        function approximateLocationLabel(data) {
            const address = data?.address || {};
            // Reverse geocoding is only a nearby-area label. It is deliberately
            // not presented as an exact address because device GPS and mapping
            // boundaries can disagree at subdistrict level.
            const area = address.suburb || address.quarter || address.neighbourhood || address.village || address.hamlet || address.subdistrict || '';
            const city = address.municipality || address.town || address.city || address.city_district || address.district || address.county || '';
            const province = address.state || address.province || '';
            return [area, city, province].filter(Boolean).filter((value, index, parts) => parts.indexOf(value) === index).join(' · ');
        }

        async function fetchApproximateLocationName(lat, lng) {
            const roundedLat = roundedCoordinate(lat);
            const roundedLng = roundedCoordinate(lng);
            const data = await fetchEnvironmentJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${roundedLat}&lon=${roundedLng}&zoom=14&addressdetails=1&accept-language=th`, 4000);
            return approximateLocationLabel(data);
        }

        async function fetchWithTimeout(url, timeoutMs = 12000) {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetch(url, { signal: controller.signal });
            } finally {
                window.clearTimeout(timeoutId);
            }
        }

        function weatherCodeLabel(code) {
            const labels = {
                0: 'ท้องฟ้าโปร่ง', 1: 'มีเมฆเล็กน้อย', 2: 'มีเมฆเป็นบางส่วน', 3: 'เมฆมาก',
                45: 'มีหมอก', 48: 'มีหมอกน้ำค้างแข็ง', 51: 'ฝนปรอยเล็กน้อย', 53: 'ฝนปรอย',
                55: 'ฝนปรอยหนัก', 56: 'ฝนเยือกแข็งเล็กน้อย', 57: 'ฝนเยือกแข็งหนัก', 61: 'ฝนเล็กน้อย',
                63: 'ฝนปานกลาง', 65: 'ฝนหนัก', 66: 'ฝนเยือกแข็ง', 67: 'ฝนเยือกแข็งหนัก',
                71: 'หิมะเล็กน้อย', 73: 'หิมะปานกลาง', 75: 'หิมะหนัก', 77: 'เกล็ดหิมะ',
                80: 'ฝนซู่เล็กน้อย', 81: 'ฝนซู่ปานกลาง', 82: 'ฝนซู่หนัก', 85: 'หิมะซู่เล็กน้อย',
                86: 'หิมะซู่หนัก', 95: 'พายุฝนฟ้าคะนอง', 96: 'พายุฝนฟ้าคะนองและลูกเห็บ', 99: 'พายุฝนฟ้าคะนองและลูกเห็บหนัก'
            };
            return labels[Number(code)] || 'ไม่ทราบสภาพท้องฟ้า';
        }

        function formatEnvironmentUpdatedAt(timestamp) {
            return new Intl.DateTimeFormat('th-TH', {
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(timestamp || Date.now()));
        }

        function formatProviderCurrentTime(currentTime, timezone) {
            if (!currentTime) return 'ไม่ระบุเวลา';
            const readableTime = String(currentTime).replace('T', ' ');
            return timezone ? `${readableTime} (${timezone})` : readableTime;
        }

        function formatGpsAccuracy(accuracyMeters) {
            return Number.isFinite(accuracyMeters) ? `ความคลาดเคลื่อนของตำแหน่งจากอุปกรณ์ประมาณ ±${Math.round(accuracyMeters)} ม.` : 'อุปกรณ์ไม่ระบุความคลาดเคลื่อนของตำแหน่ง';
        }

        async function fetchEnvironmentJson(url, timeoutMs, parentSignal, body = null) {
            const controller = new AbortController();
            const abort = () => controller.abort();
            if (parentSignal?.aborted) controller.abort();
            parentSignal?.addEventListener('abort', abort, { once: true });
            const timer = window.setTimeout(abort, timeoutMs);
            try {
                const response = await fetch(url, { signal: controller.signal, cache: 'no-store',
                    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify(body) } : {}) });
                if (!response.ok) throw new Error('Environment provider unavailable');
                const data = await response.json();
                if (controller.signal.aborted) throw new Error('Environment request cancelled');
                return data;
            } finally {
                window.clearTimeout(timer);
                parentSignal?.removeEventListener('abort', abort);
            }
        }

        async function fetchLiveWeatherData(lat, lng, locationMeta = {}, requestId = environmentRequestId, signal = environmentController?.signal) {
            const isActive = () => requestId === environmentRequestId && !signal?.aborted;
            const roundedLat = roundedCoordinate(lat);
            const roundedLng = roundedCoordinate(lng);
            const selectedArea = locationMeta.source === 'selected-area';
            let weather = null, aqi = null, airTime = '', locationName = selectedArea ? locationMeta.approximateName : '', airSettled = false, locationSettled = selectedArea;
            const render = () => {
                if (!isActive() || !weather) return;
                const current = weather.current;
                if (!selectedArea) currentLocationMeta.approximateName = locationName;
                document.getElementById('environment-area-text').textContent = selectedArea
                    ? `พื้นที่ที่คุณเลือก: ${locationName} — ไม่ใช่ตำแหน่ง GPS ของอุปกรณ์`
                    : locationName
                    ? `พื้นที่ใกล้เคียงจากตำแหน่งปัจจุบัน: ${locationName}` : `อากาศตามตำแหน่งปัจจุบันของอุปกรณ์คุณ (${locationSettled ? 'บริการชื่อพื้นที่ไม่พร้อมใช้งาน' : 'กำลังโหลดชื่อพื้นที่'})`;
                document.getElementById('environment-current-weather').textContent = `สภาพอากาศปัจจุบัน: ${weatherCodeLabel(current.weather_code)}`;
                updateCardsUI(Math.round(current.uv_index), current.temperature_2m, Math.round(current.relative_humidity_2m), aqi,
                    weatherCodeLabel(current.weather_code), locationName, current.is_day);
                if (aqi === null) {
                    document.getElementById('card-aqi-status').textContent = airSettled ? 'บริการ AQI ไม่พร้อม' : 'กำลังโหลด AQI…';
                    liveEnvData.aqi.status = document.getElementById('card-aqi-status').textContent;
                }
                setEnvironmentSourceText(
                    `Open-Meteo · อากาศ ${formatProviderCurrentTime(current.time, weather.timezone_abbreviation || weather.timezone)} · AQI ${airTime || (airSettled ? 'ไม่พร้อมใช้งาน' : 'กำลังโหลด')}`,
                    selectedArea
                        ? 'ข้อมูลอากาศเป็นค่าประมาณของพื้นที่ที่เลือก ไม่ใช่ตำแหน่ง GPS ของอุปกรณ์หรือเซนเซอร์โทรศัพท์ และไม่บันทึกในบัญชี'
                        : `ข้อมูลอากาศปัจจุบันเป็นค่าประมาณจากกริดพยากรณ์ ไม่ใช่เซนเซอร์โทรศัพท์ ขอพิกัดใหม่เวลา ${formatEnvironmentUpdatedAt(locationMeta.capturedAt)} (${formatGpsAccuracy(locationMeta.accuracyMeters)}) ส่งพิกัดแบบปัดทศนิยม 4 ตำแหน่งและไม่บันทึกในบัญชี`,
                );
            };
            // Optional providers run independently: a slow place name or AQI
            // must never delay or erase valid current weather.
            fetchEnvironmentJson('/api/environment', 8000, signal, { kind: 'air', latitude: roundedLat, longitude: roundedLng })
                .then((data) => {
                    const value = data.current?.us_aqi;
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid AQI');
                    aqi = Math.round(value);
                    airTime = formatProviderCurrentTime(data.current.time, data.timezone_abbreviation || data.timezone);
                }).catch(() => {}).finally(() => { airSettled = true; render(); });
            if (!selectedArea) fetchEnvironmentJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${roundedLat}&lon=${roundedLng}&zoom=14&addressdetails=1&accept-language=th`, 4000, signal)
                .then((data) => { locationName = approximateLocationLabel(data); }).catch(() => {}).finally(() => { locationSettled = true; render(); });
            try {
                const data = await fetchEnvironmentJson('/api/environment', 8000, signal, { kind: 'weather', latitude: roundedLat, longitude: roundedLng });
                const current = data.current;
                if (!current || !['uv_index', 'temperature_2m', 'relative_humidity_2m'].every((key) => typeof current[key] === 'number' && Number.isFinite(current[key]))
                    || current.uv_index < 0 || current.relative_humidity_2m < 0 || current.relative_humidity_2m > 100) throw new Error('Invalid weather data');
                if (!isActive()) return;
                weather = data;
                render();
            } catch (err) {
                if (!isActive()) return;
                showEnvironmentUnavailable(navigator.onLine
                    ? 'เชื่อมต่อบริการข้อมูลอากาศไม่สำเร็จ โปรดลองอีกครั้ง'
                    : 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต จึงยังโหลดข้อมูลอากาศตามตำแหน่งไม่ได้');
            }
        }

        function showEnvironmentUnavailable(message) {
            resetEnvironmentCards('ไม่มีข้อมูล');
            document.getElementById('location-text').textContent = 'ใช้ตำแหน่งล่าสุดของฉัน';
            document.getElementById('environment-area-text').textContent = message;
            document.getElementById('environment-current-weather').textContent = 'ยังไม่มีข้อมูลอากาศปัจจุบัน';
            document.getElementById('env-summary-text').textContent = 'ไม่สามารถแสดงข้อมูลอากาศตามตำแหน่งได้ โปรดใช้คำแนะนำทั่วไปและหลีกเลี่ยงการตีความเป็นผลทางการแพทย์';
            setEnvironmentSourceText(
                message,
                navigator.onLine
                    ? 'โปรดตรวจสิทธิ์ Location และลองอัปเดตอีกครั้ง ระบบจะไม่ใช้ชื่อพื้นที่หรือข้อมูลอากาศเก่ามาแสดงแทน'
                    : 'ออฟไลน์อยู่ จึงไม่สามารถเรียกตำแหน่งย้อนกลับ แผนที่ หรือข้อมูลอากาศใหม่ได้ แต่หน้าเว็บส่วนอื่นยังใช้งานได้',
            );
        }

        function updateCardsUI(uv, temp, hum, aqi, weatherDescription = '', locationName = '', isDay = null) {
            let uvStatus = "ต่ำ", uvClass = "bg-emerald-50 text-emerald-600 border-emerald-100", uvBadgeClass = "bg-emerald-100 text-emerald-700", uvDesc = "รังสี UV ปลอดภัย";
            if (uv >= 3 && uv <= 5) { uvStatus = "ปานกลาง"; uvClass = "bg-yellow-50 text-yellow-600 border-yellow-100"; uvBadgeClass = "bg-yellow-100 text-yellow-700"; uvDesc = "เริ่มมีรังสี UV ควรทากันแดดเมื่อต้องออกแจ้ง"; }
            else if (uv >= 6 && uv <= 7) { uvStatus = "สูง"; uvClass = "bg-orange-50 text-orange-600 border-orange-100"; uvBadgeClass = "bg-orange-100 text-orange-700"; uvDesc = "รังสี UV สูง ควรทาครีมกันแดด SPF 50+ และสวมหมวก"; }
            else if (uv >= 8) { uvStatus = "สูงมาก"; uvClass = "bg-rose-50 text-rose-600 border-rose-100"; uvBadgeClass = "bg-rose-100 text-rose-700"; uvDesc = "รังสี UV สูงมาก เสี่ยงต่อผิวไหม้แดด ควรหลีกเลี่ยงแดดจัด"; }

            document.getElementById('card-uv-val').textContent = uv;
            const cardUvStatus = document.getElementById('card-uv-status');
            cardUvStatus.textContent = uvStatus;
            cardUvStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${uvClass}`;

            let tempStatus = "สบาย", tempClass = "bg-emerald-50 text-emerald-600 border-emerald-100", tempBadgeClass = "bg-emerald-100 text-emerald-700", tempDesc = "อุณหภูมิสบายตัว";
            if (temp > 32) { tempStatus = "ร้อน"; tempClass = "bg-orange-50 text-orange-600 border-orange-100"; tempBadgeClass = "bg-orange-100 text-orange-700"; tempDesc = "อากาศร้อน เช็ดเหงื่อป้องกันอุดตัน"; }
            else if (temp < 22) { tempStatus = "เย็น"; tempClass = "bg-blue-50 text-blue-600 border-blue-100"; tempBadgeClass = "bg-blue-100 text-blue-700"; tempDesc = "อากาศเย็น เติมความชุ่มชื้นผิว"; }

            const tempDisplay = Number(temp).toFixed(1);
            document.getElementById('card-temp-val').textContent = `${tempDisplay}°C`;
            const cardTempStatus = document.getElementById('card-temp-status');
            cardTempStatus.textContent = tempStatus;
            cardTempStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${tempClass}`;

            let humStatus = "ปกติ", humClass = "bg-emerald-50 text-emerald-600 border-emerald-100", humBadgeClass = "bg-emerald-100 text-emerald-700", humDesc = "ความชื้นสมดุล";
            if (hum > 70) { humStatus = "ค่อนข้างสูง"; humClass = "bg-blue-50 text-blue-600 border-blue-100"; humBadgeClass = "bg-blue-100 text-blue-700"; humDesc = "ความชื้นสูง ควรอยู่ในที่ระบายอากาศดี"; }
            else if (hum < 40) { humStatus = "แห้ง"; humClass = "bg-amber-50 text-amber-600 border-amber-100"; humBadgeClass = "bg-amber-100 text-amber-700"; humDesc = "อากาศแห้ง ควรเพิ่มความชุ่มชื้น"; }

            document.getElementById('card-humidity-val').textContent = `${hum}%`;
            const cardHumStatus = document.getElementById('card-humidity-status');
            cardHumStatus.textContent = humStatus;
            cardHumStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${humClass}`;

            let aqiStatus = "ดีมาก", aqiClass = "bg-emerald-50 text-emerald-600 border-emerald-100", aqiBadgeClass = "bg-emerald-100 text-emerald-700", aqiDesc = "อากาศสะอาด";
            if (aqi > 50 && aqi <= 100) { aqiStatus = "ปานกลาง"; aqiClass = "bg-yellow-50 text-yellow-600 border-yellow-100"; aqiBadgeClass = "bg-yellow-100 text-yellow-700"; aqiDesc = "มีฝุ่นสะสมปานกลาง ล้างหน้าหลังเข้าบ้าน"; }
            else if (aqi > 100) { aqiStatus = "มีผลกระทบ"; aqiClass = "bg-rose-50 text-rose-600 border-rose-100"; aqiBadgeClass = "bg-rose-100 text-rose-700"; aqiDesc = "ฝุ่นละอองสูง สวมหน้ากากและล้างหน้าให้สะอาด"; }

            document.getElementById('card-aqi-val').textContent = aqi === null ? '—' : aqi;
            const cardAqiStatus = document.getElementById('card-aqi-status');
            cardAqiStatus.textContent = aqi === null ? 'ไม่มีข้อมูล AQI' : aqiStatus;
            cardAqiStatus.className = `inline-block px-2.5 py-0.5 text-xs font-bold rounded-full border ${aqiClass}`;

            const currentHour = new Date().getHours();
            const isDaytime = isDay === 0 || isDay === 1 ? isDay === 1 : currentHour >= 6 && currentHour < 18;

            const timeBadge = document.getElementById('time-period-badge');
            const timeText = document.getElementById('time-period-text');

            if (isDaytime) {
                timeBadge.className = "px-3 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/40";
                timeText.textContent = "☀️ ช่วงเวลากลางวัน (Daytime)";
            } else {
                timeBadge.className = "px-3 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40";
                timeText.textContent = "🌙 ช่วงเวลากลางคืน (Nighttime)";
            }

            const timePeriodLabel = isDaytime ? "กลางวัน" : "กลางคืน";
            const areaText = locationName ? `สำหรับ ${locationName} ` : '';
            const weatherText = weatherDescription ? `${weatherDescription}, ` : '';
            document.getElementById('env-summary-text').textContent = `${areaText}สภาพอากาศโดยประมาณจากแหล่งข้อมูลปัจจุบัน (${timePeriodLabel}): ${weatherText}อุณหภูมิ ${tempDisplay}°C, ค่า UV อยู่ที่ ${uv} (${uvStatus}) และความชื้น ${hum}% (${humStatus}) สรุปคำแนะนำดูแลผิวทั่วไปดังนี้`;

            if (isDaytime) {
                document.getElementById('rec-1').textContent = uv >= 3 ? 'ทาครีมกันแดด SPF 30-50+ เป็นประจำก่อนออกแดด' : 'ทาครีมกันแดดเนื้อบางเบาเพื่อปกป้องผิว';
                document.getElementById('rec-2').textContent = temp > 30 ? 'สวมเสื้อผ้าแขนยาวระบายอากาศดี ป้องกันความร้อน' : 'สวมเสื้อผ้าปกคลุมผิวอย่างเหมาะสม';
                document.getElementById('rec-3').textContent = 'หลีกเลี่ยงแดดจัดและเตรียมหมวกหรือร่มกัน UV';
                document.getElementById('rec-4').textContent = 'จิบน้ำสะอาดอย่างน้อย 8 แก้ว เติมความชุ่มชื้นตลอดวัน';
            } else {
                document.getElementById('rec-1').textContent = 'ทำความสะอาดผิวหน้า (Double Cleansing) ล้างคราบฝุ่นละออง';
                document.getElementById('rec-2').textContent = hum < 50 ? 'ทา Night Cream หรือมอยส์เจอไรเซอร์เติมความชุ่มชื้น' : 'ทาบำรุงผิวสูตรบางเบา ไม่ให้อุดตันรูขุมขน';
                document.getElementById('rec-3').textContent = 'เปิดเครื่องฟอกอากาศและปิดหน้าต่างลดฝุ่นละอองสะสม';
                document.getElementById('rec-4').textContent = 'ดื่มน้ำ 1 แก้วก่อนนอน เพื่อฟื้นฟูเกราะป้องกันผิวตลอดคืน';
            }

            if (typeof lucide !== 'undefined') lucide.createIcons();

            liveEnvData.uv = { val: uv, status: uvStatus, title: "UV Index (ดัชนีรังสีอุลตราไวโอเลต)", badge: uvStatus, badgeClass: uvBadgeClass, iconBg: "bg-amber-100 text-amber-600", icon: "sun", desc: uvDesc };
            liveEnvData.temp = { val: `${tempDisplay}°C`, status: tempStatus, title: "อุณหภูมิอากาศโดยประมาณ (Temperature)", badge: tempStatus, badgeClass: tempBadgeClass, iconBg: "bg-orange-100 text-orange-600", icon: "thermometer", desc: `${tempDesc} ค่านี้มาจากกริดข้อมูลอากาศ จึงอาจไม่ตรงกับแอปหรือสถานีวัดอื่น` };
            liveEnvData.humidity = { val: `${hum}%`, status: humStatus, title: "ความชื้นสัมพัทธ์ (Humidity)", badge: humStatus, badgeClass: humBadgeClass, iconBg: "bg-blue-100 text-blue-600", icon: "droplets", desc: humDesc };
            liveEnvData.aqi = { val: aqi === null ? '—' : aqi, status: aqi === null ? 'ไม่มีข้อมูล AQI' : aqiStatus, title: "ดัชนีคุณภาพอากาศ (AQI)", badge: aqi === null ? 'ไม่มีข้อมูล AQI' : aqiStatus, badgeClass: aqiBadgeClass, iconBg: "bg-emerald-100 text-emerald-600", icon: "wind", desc: aqi === null ? 'บริการคุณภาพอากาศยังไม่ส่งข้อมูลสำหรับตำแหน่งนี้ อุณหภูมิและข้อมูลอากาศที่แสดงยังใช้งานได้' : aqiDesc };
        }

        // 🏥 ระบบค้นหาสถานพยาบาลและหมุดตำแหน่งโดยประมาณของผู้ใช้ 🏥
        function clearMapLocationConsent() {
            // Map consent is deliberately scoped to the currently open modal.
            // A previously acquired browser position may remain in memory for
            // the separate weather feature, but it must never be added to a
            // map/search URL without a fresh, explicit map opt-in.
            mapLocationConsent = false;
            mapGoogleMapsLocationConsent = false;
            ++mapLocationRequestId;
            window.clearTimeout(mapLocationDeadline);
            document.getElementById('mapLocationButton').disabled = false;
            document.getElementById('mapLocationConsentCheck').checked = false;
            document.getElementById('googleMapLocationConsentCheck').checked = false;
            document.getElementById('mapLocationButton').textContent = 'แสดงตำแหน่งปัจจุบันโดยประมาณบนแผนที่';
        }

        function mayShareLocationWithGoogleMaps() {
            return mapLocationConsent
                && mapGoogleMapsLocationConsent
                && document.getElementById('googleMapLocationConsentCheck')?.checked === true
                && Number.isFinite(currentLat)
                && Number.isFinite(currentLng);
        }

        function openMapModal(category = 'dermatologist') {
            clearMapLocationConsent();
            setMapLocationStatus('เลือกคำค้นหาได้โดยไม่ใช้ตำแหน่ง หรือยืนยันด้านล่างเพื่อแสดงหมุดตำแหน่งล่าสุดของคุณ');
            filterMapSearch(category);
            showAccessibleModal('mapModal', '#customSearchInput');
        }

        function filterMapSearch(category) {
            let queryText = "คลินิกโรคผิวหนัง";
            const btnDerm = document.getElementById('mapBtnDerm');
            const btnHosp = document.getElementById('mapBtnHosp');
            const btnPharm = document.getElementById('mapBtnPharm');

            btnDerm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5 transition-all";
            btnHosp.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5 transition-all";
            btnPharm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5 transition-all";

            if (category === 'dermatologist') {
                queryText = "คลินิกโรคผิวหนัง หมอผิวหนัง";
                btnDerm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-teal-700 text-white shadow-sm flex items-center gap-1.5 transition-all";
            } else if (category === 'hospital') {
                queryText = "แผนกผิวหนัง ศูนย์โรคผิวหนัง โรงพยาบาล";
                btnHosp.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-teal-700 text-white shadow-sm flex items-center gap-1.5 transition-all";
            } else if (category === 'pharmacy') {
                queryText = "ร้านขายยา ยาทาผิวหนัง";
                btnPharm.className = "px-3.5 py-2 rounded-xl text-xs font-bold bg-teal-700 text-white shadow-sm flex items-center gap-1.5 transition-all";
            }

            executeSearchWithQuery(queryText);
        }

        function executeCustomSearch() {
            const searchInput = document.getElementById('customSearchInput').value.trim().slice(0, 150);
            if (searchInput !== '') {
                executeSearchWithQuery(searchInput + " โรคผิวหนัง คลินิก โรงพยาบาล");
            } else setMapLocationStatus('พิมพ์ชื่อจังหวัด อำเภอ หรือสถานพยาบาลก่อนกดค้นหา หรือเลือกประเภทด้านบน', true);
        }

        function handleSearchKeyPress(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                executeCustomSearch();
            }
        }

        function buildOpenStreetMapEmbedUrl(lat, lng) {
            const markerLat = roundedCoordinate(lat);
            const markerLng = roundedCoordinate(lng);
            const span = 0.012;
            const bbox = [markerLng - span, markerLat - span, markerLng + span, markerLat + span]
                .map((coordinate) => coordinate.toFixed(4))
                .join('%2C');
            return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${markerLat.toFixed(4)}%2C${markerLng.toFixed(4)}`;
        }

        function showCurrentLocationMarker() {
            const markerLat = roundedCoordinate(currentLat);
            const markerLng = roundedCoordinate(currentLng);
            const nearbyName = currentLocationMeta.approximateName;
            const nearbyLabel = nearbyName ? `พื้นที่ใกล้เคียง: ${nearbyName}` : 'ตำแหน่งโดยประมาณจากอุปกรณ์';
            document.getElementById('coords-text').textContent = `หมุดตำแหน่งปัจจุบันโดยประมาณ — ${nearbyLabel}`;
            loadMapFrame(buildOpenStreetMapEmbedUrl(markerLat, markerLng));
            const externalButton = document.getElementById('btnExternalNav');
            const externalButtonText = document.getElementById('btnExternalNavText');
            if (mayShareLocationWithGoogleMaps()) {
                externalButton.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lastMapQuery} ใกล้ ${markerLat.toFixed(4)},${markerLng.toFixed(4)}`)}`;
                externalButtonText.textContent = 'ค้นหาสถานพยาบาลใกล้ตำแหน่งใน Google Maps';
            } else {
                externalButton.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lastMapQuery)}`;
                externalButtonText.textContent = 'ค้นหาใน Google Maps';
                setMapLocationStatus(`แสดงหมุดผ่าน OpenStreetMap แล้ว (${formatGpsAccuracy(currentLocationMeta.accuracyMeters)}) Google Maps ยังไม่ได้รับพิกัดของคุณ`);
            }
            document.getElementById('medicalMapExternalTop').href = externalButton.href;
        }

        function executeSearchWithQuery(queryText) {
            lastMapQuery = queryText;
            const hasMapLocation = mapLocationConsent && Number.isFinite(currentLat) && Number.isFinite(currentLng);
            const shareWithGoogle = mayShareLocationWithGoogleMaps();
            const locationStatus = shareWithGoogle
                ? ' — Google Maps จัดกึ่งกลางผลค้นหาตามพิกัดโดยประมาณที่คุณยินยอม'
                : hasMapLocation
                    ? ' — มีหมุด OpenStreetMap โดยประมาณ แต่ Google Maps ค้นหาโดยไม่ใช้ตำแหน่ง'
                    : ' — ค้นหาโดยไม่ใช้ตำแหน่งของคุณ';
            document.getElementById('coords-text').textContent = `ค้นหาคำสำคัญ: ${queryText}${locationStatus}`;

            if (!navigator.onLine) {
                showMapFrameFallback('ออฟไลน์อยู่ จึงยังโหลดแผนที่หรือผลค้นหาสถานพยาบาลไม่ได้');
                document.getElementById('btnExternalNav').href = '#';
                document.getElementById('medicalMapExternalTop').href = '#';
                return;
            }

            const locationQuery = shareWithGoogle ? `&ll=${roundedCoordinate(currentLat)},${roundedCoordinate(currentLng)}&z=13` : '';
            // Use the already-allowlisted host; maps.google.com is blocked by CSP.
            const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(queryText)}${locationQuery}&output=embed`;
            loadMapFrame(mapUrl);
            document.getElementById('btnExternalNav').href = shareWithGoogle
                ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${queryText} ใกล้ ${roundedCoordinate(currentLat)},${roundedCoordinate(currentLng)}`)}`
                : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(queryText)}`;
            document.getElementById('btnExternalNavText').textContent = 'ค้นหาใน Google Maps';
            document.getElementById('medicalMapExternalTop').href = document.getElementById('btnExternalNav').href;
        }

        function useCurrentLocationForMap() {
            if (!window.isSecureContext) {
                const message = insecureLocationContextMessage();
                document.getElementById('coords-text').textContent = message;
                setMapLocationStatus(message, true);
                return;
            }
            if (!navigator.onLine) {
                const message = 'ออฟไลน์อยู่ จึงไม่สามารถเรียกแผนที่ปัจจุบันได้ โปรดเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่';
                document.getElementById('coords-text').textContent = message;
                showMapFrameFallback(message);
                setMapLocationStatus(message, true);
                return;
            }
            if (!navigator.geolocation) {
                const message = 'เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง จึงค้นหาโดยไม่ใช้ตำแหน่ง';
                document.getElementById('coords-text').textContent = message;
                setMapLocationStatus(message, true);
                return;
            }
            if (!document.getElementById('mapLocationConsentCheck').checked) {
                setMapLocationStatus('โปรดยืนยันความยินยอมด้านบนก่อนขอตำแหน่งจากเบราว์เซอร์', true);
                return;
            }

            // Capture the Google-specific choice before the browser GPS prompt.
            // It prevents a coordinate obtained for OpenStreetMap from being
            // sent to Google merely because the checkbox is ticked later.
            const wantsGoogleMapsLocation = document.getElementById('googleMapLocationConsentCheck').checked === true;
            const button = document.getElementById('mapLocationButton');
            if (button.disabled) return;
            const requestId = ++mapLocationRequestId;
            let finished = false;
            const active = () => !finished && requestId === mapLocationRequestId && !document.getElementById('mapModal').classList.contains('hidden');
            button.disabled = true;
            document.getElementById('coords-text').textContent = 'กำลังขอตำแหน่งล่าสุดจากอุปกรณ์';
            setMapLocationStatus('กำลังขอตำแหน่งใหม่ โดยไม่ใช้พิกัดที่ค้างอยู่ในหน้าเว็บ');
            const fail = (error) => {
                if (!active()) return;
                finished = true;
                window.clearTimeout(mapLocationDeadline);
                button.disabled = false;
                mapLocationConsent = false;
                mapGoogleMapsLocationConsent = false;
                executeSearchWithQuery(lastMapQuery);
                setMapLocationStatus(`${locationErrorMessage(error)} — ยังค้นหาสถานพยาบาลด้วยชื่อพื้นที่หรือ Google Maps ได้`, true);
            };
            mapLocationDeadline = window.setTimeout(() => fail({ code: 3 }), 30000);
            // A map request is a separate consent action. Always ask for a fresh
            // browser position instead of reusing an earlier weather/map reading.
            const acquire = (highAccuracy) => navigator.geolocation.getCurrentPosition(
                (position) => {
                    if (!active()) return;
                    const { latitude, longitude } = position?.coords || {};
                    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return fail({ code: 2 });
                    finished = true;
                    window.clearTimeout(mapLocationDeadline);
                    button.disabled = false;
                    saveFreshBrowserLocation(position);
                    mapLocationConsent = true;
                    mapGoogleMapsLocationConsent = wantsGoogleMapsLocation;
                    document.getElementById('mapLocationButton').textContent = 'อัปเดตหมุดตำแหน่งปัจจุบันอีกครั้ง';
                    // Show the marker immediately; reverse geocoding is optional.
                    showCurrentLocationMarker();
                    if (mayShareLocationWithGoogleMaps()) {
                        setMapLocationStatus(`แสดงหมุดพิกัดโดยประมาณแล้ว (${formatGpsAccuracy(currentLocationMeta.accuracyMeters)}) และอนุญาตให้ Google Maps ใช้พิกัดสำหรับค้นหา`);
                    }
                    fetchApproximateLocationName(currentLat, currentLng).then((name) => {
                        if (requestId !== mapLocationRequestId || !mapLocationConsent) return;
                        currentLocationMeta.approximateName = name;
                        document.getElementById('coords-text').textContent = `หมุดตำแหน่งปัจจุบันโดยประมาณ${name ? ` — ${name}` : ''}`;
                    }).catch(() => {});
                },
                (error) => {
                    if (!active()) return;
                    if (!highAccuracy && (error?.code === 2 || error?.code === 3)) acquire(true);
                    else fail(error);
                },
                { enableHighAccuracy: highAccuracy, timeout: highAccuracy ? 10000 : 6000, maximumAge: 0 }
            );
            try { acquire(false); } catch (error) { fail(error); }
        }

        function closeMapModal() {
            clearMapLocationConsent();
            // Stop an embedded third-party map once the dialog is dismissed so
            // it cannot retain a location-bearing URL in this page session.
            const frame = document.getElementById('googleMapIframe');
            if (frame) frame.src = '';
            hideAccessibleModal('mapModal');
        }

        function openEnvDetailModal(type) {
            const data = liveEnvData[type];
            if (!data) return;
            document.getElementById('envModalTitle').textContent = data.title;
            document.getElementById('envModalValue').textContent = `${data.val} (${data.status})`;
            const badge = document.getElementById('envModalBadge');
            badge.textContent = data.badge;
            badge.className = `inline-block text-[11px] font-bold px-2.5 py-0.5 rounded-full mt-1 ${data.badgeClass}`;
            const iconDiv = document.getElementById('envModalIcon');
            iconDiv.className = `p-3 rounded-2xl ${data.iconBg}`;
            iconDiv.innerHTML = `<i data-lucide="${data.icon}" class="w-6 h-6"></i>`;
            document.getElementById('envModalDesc').textContent = data.desc;
            if (typeof lucide !== 'undefined') lucide.createIcons();
            showAccessibleModal('envDetailModal', '[data-modal-close]');
        }
        function closeEnvDetailModal() { hideAccessibleModal('envDetailModal'); }

        function switchForm(type) {
            const formLogin = document.getElementById('formLogin');
            const formRegister = document.getElementById('formRegister');
            const btnTabLogin = document.getElementById('btnTabLogin');
            const btnTabRegister = document.getElementById('btnTabRegister');

            if (!formLogin || !formRegister || !btnTabLogin || !btnTabRegister) return;

            if (type === 'login') {
                formLogin.classList.remove('hidden');
                formRegister.classList.add('hidden');
                btnTabLogin.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all bg-white text-slate-900 shadow-sm";
                btnTabRegister.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all text-slate-500 hover:text-slate-900";
                btnTabLogin.setAttribute('aria-selected', 'true');
                btnTabRegister.setAttribute('aria-selected', 'false');
            } else {
                formLogin.classList.add('hidden');
                formRegister.classList.remove('hidden');
                btnTabLogin.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all text-slate-500 hover:text-slate-900";
                btnTabRegister.className = "w-1/2 text-sm font-bold py-2.5 rounded-lg transition-all bg-white text-teal-600 shadow-sm";
                btnTabLogin.setAttribute('aria-selected', 'false');
                btnTabRegister.setAttribute('aria-selected', 'true');
            }
        }

        function setAccountStatus(message, tone = 'info') {
            const status = document.getElementById('accountStatus');
            if (!status) return;
            const styles = {
                info: 'border-teal-200 bg-teal-50 text-teal-900',
                success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
                error: 'border-rose-200 bg-rose-50 text-rose-900',
                warning: 'border-amber-200 bg-amber-50 text-amber-900',
            };
            status.className = `mt-5 rounded-xl border px-4 py-3 text-center text-xs leading-relaxed ${styles[tone] || styles.info}`;
            status.textContent = message;
            status.focus();
        }

        function setAccountBusy(form, isBusy) {
            const submit = form?.querySelector('button[type="submit"]');
            if (!submit) return;
            if (!submit.dataset.defaultLabel) submit.dataset.defaultLabel = submit.textContent;
            submit.disabled = isBusy;
            submit.classList.toggle('opacity-60', isBusy);
            submit.classList.toggle('cursor-wait', isBusy);
            submit.textContent = isBusy ? 'กำลังดำเนินการ…' : submit.dataset.defaultLabel;
        }

        function showAccountSession(user) {
            const formLogin = document.getElementById('formLogin');
            const formRegister = document.getElementById('formRegister');
            const tabs = document.getElementById('btnTabLogin')?.parentElement;
            const panel = document.getElementById('accountSessionPanel');
            const name = document.getElementById('accountSessionName');
            if (!formLogin || !formRegister || !tabs || !panel || !name) return;
            formLogin.classList.add('hidden');
            formRegister.classList.add('hidden');
            tabs.classList.add('hidden');
            name.textContent = `ยินดีต้อนรับ ${user.name} (${user.email})`;
            panel.classList.remove('hidden');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        let pendingAdminMfaChallenge = '';

        function showAccountForms() {
            const formLogin = document.getElementById('formLogin');
            const panel = document.getElementById('accountSessionPanel');
            const tabs = document.getElementById('btnTabLogin')?.parentElement;
            panel?.classList.add('hidden');
            tabs?.classList.remove('hidden');
            formLogin?.reset();
            document.getElementById('formRegister')?.reset();
            pendingAdminMfaChallenge = '';
            document.getElementById('loginMfaPanel')?.classList.add('hidden');
            const loginSubmit = document.getElementById('loginSubmit');
            if (loginSubmit) {
                delete loginSubmit.dataset.defaultLabel;
                loginSubmit.textContent = 'เข้าสู่ระบบ (Sign In)';
            }
            switchForm('login');
        }

        async function accountRequest(path, body) {
            const response = await fetch(path, {
                method: body ? 'POST' : 'GET',
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                credentials: 'same-origin',
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || 'ไม่สามารถเชื่อมต่อระบบบัญชีได้ในขณะนี้');
            return data;
        }

        async function submitAccountForm(event) {
            event.preventDefault();
            const form = event.currentTarget;
            const isRegister = form.id === 'formRegister';
            const email = form.querySelector('input[name="email"]')?.value || '';
            const password = form.querySelector('input[name="password"]')?.value || '';
            const isMfaVerification = !isRegister && Boolean(pendingAdminMfaChallenge);
            const body = isMfaVerification
                ? { challengeId: pendingAdminMfaChallenge, code: document.getElementById('loginMfaCode')?.value || '' }
                : isRegister
                ? {
                    name: document.getElementById('registerName')?.value || '',
                    email,
                    password,
                    termsAccepted: Boolean(document.getElementById('registerTerms')?.checked),
                }
                : { email, password };
            setAccountBusy(form, true);
            try {
                const endpoint = isMfaVerification ? '/api/admin/mfa/verify' : `/api/account/${isRegister ? 'register' : 'login'}`;
                const result = await accountRequest(endpoint, body);
                if (result.mfaRequired) {
                    pendingAdminMfaChallenge = result.challengeId;
                    document.getElementById('loginMfaPanel')?.classList.remove('hidden');
                    const loginSubmit = document.getElementById('loginSubmit');
                    if (loginSubmit) {
                        loginSubmit.dataset.defaultLabel = 'ยืนยันรหัส MFA';
                        loginSubmit.textContent = 'ยืนยันรหัส MFA';
                    }
                    document.getElementById('loginMfaCode')?.focus();
                    setAccountStatus(result.message || 'กรุณากรอกรหัส 6 หลักจากแอปยืนยันตัวตน', 'info');
                    return;
                }
                if (result.mfaEnrollmentRequired) {
                    window.location.assign('/admin-mfa-enroll.html');
                    return;
                }
                form.reset();
                if (result.pendingApproval) {
                    switchForm('login');
                    setAccountStatus(result.message || 'ลงทะเบียนสำเร็จแล้ว กรุณารอผู้ดูแลระบบยืนยันบัญชีก่อนเข้าใช้งาน', 'info');
                    return;
                }
                setAccountStatus(result.message || 'เข้าสู่ระบบเรียบร้อยแล้ว', 'success');
                window.location.assign(result.user?.role === 'admin' ? '/admin.html' : '/dashboard.html');
            } catch (error) {
                setAccountStatus(error.message || 'ไม่สามารถดำเนินการได้ในขณะนี้', 'error');
            } finally {
                setAccountBusy(form, false);
            }
        }

        async function restoreAccountSession() {
            // A rejected protected-page request must not be auto-routed straight
            // back to that page using a still-readable session cookie.
            if (new URLSearchParams(window.location.search).get('signin') === '1') {
                setAccountStatus('กรุณาเข้าสู่ระบบอีกครั้งเพื่อยืนยันสิทธิ์ใช้งาน', 'info');
                return;
            }
            try {
                const result = await accountRequest('/api/account/me');
                if (result.user?.role === 'admin') {
                    window.location.replace('/admin.html');
                    return;
                }
                if (result.user) window.location.replace('/dashboard.html');
            } catch (error) {
                if (/กำลังตั้งค่า/.test(error.message || '')) setAccountStatus(error.message, 'warning');
            }
        }

        function openAccountLogoutModal() {
            const modal = document.getElementById('accountLogoutModal');
            if (!modal) return;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            modal.setAttribute('aria-hidden', 'false');
            document.getElementById('accountLogoutConfirmButton')?.focus();
        }

        function closeAccountLogoutModal() {
            const modal = document.getElementById('accountLogoutModal');
            if (!modal) return;
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.setAttribute('aria-hidden', 'true');
            document.getElementById('logoutButton')?.focus();
        }

        async function logoutAccount() {
            const button = document.getElementById('accountLogoutConfirmButton');
            if (button) {
                button.disabled = true;
                button.textContent = 'กำลังออกจากระบบ…';
            }
            try {
                await accountRequest('/api/account/logout', {});
                showAccountForms();
                setAccountStatus('ออกจากระบบเรียบร้อยแล้ว', 'info');
            } catch (error) {
                setAccountStatus(error.message || 'ไม่สามารถออกจากระบบได้ในขณะนี้', 'error');
            } finally {
                if (button) {
                    button.disabled = false;
                    button.textContent = 'ตกลง';
                }
            }
        }
