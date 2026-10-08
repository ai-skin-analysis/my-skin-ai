// Educational summaries, not observations about the submitted photograph.
// Sources checked 2026-09-27. No source photographs are copied or embedded.
// General, source-linked preparation/self-care information checked 2026-10-08.
// These are not treatment prescriptions or observations about the uploaded image.
const CLASS_GUIDANCE = Object.freeze({
  acne_vulgaris: 'หลีกเลี่ยงการบีบหรือแกะตุ่ม และการขัดผิวแรง หากมีตุ่มลึกเจ็บหรือเริ่มมีแผลเป็น ควรปรึกษาแพทย์',
  rosacea: 'จดสิ่งที่สัมพันธ์กับหน้าแดงหรือแสบผิวเพื่อแจ้งแพทย์ หากปวดตาหรือการมองเห็นเปลี่ยน ควรรับการตรวจโดยเร็ว',
  eczema_unspecified: 'จดระยะเวลาที่คัน ตำแหน่งผื่น และผลิตภัณฑ์ที่สัมผัส ให้แพทย์ช่วยแยกชนิดย่อย โดยเฉพาะเมื่อเป็นซ้ำหรือรบกวนชีวิตประจำวัน',
  allergic_contact_dermatitis: 'เตรียมรายชื่อเครื่องสำอาง ผลิตภัณฑ์ และโลหะที่สัมผัสก่อนเกิดผื่น เพื่อให้แพทย์ประเมินสาเหตุ ไม่ทดสอบสารที่สงสัยกับผิวซ้ำด้วยตนเอง',
  irritant_contact_dermatitis: 'จดการสัมผัสสบู่ น้ำยาซักล้าง หรือสารจากงาน หากผื่นเป็นต่อเนื่อง เป็นซ้ำ หรือรุนแรง ควรปรึกษาแพทย์',
  psoriasis: 'บันทึกตำแหน่งและช่วงที่ผื่นกำเริบ รวมถึงการเปลี่ยนแปลงของเล็บหรืออาการข้อ เพื่อประกอบการตรวจโดยแพทย์',
  urticaria: 'จดเวลาที่ผื่นขึ้นและยุบ รวมถึงสิ่งที่สัมผัส หากปาก ลิ้น หรือคอบวม หรือหายใจลำบาก ให้ขอความช่วยเหลือฉุกเฉินทันที ไม่รอผลสแกน',
  pityriasis_rosea: 'บันทึกว่าปื้นแรกเกิดเมื่อใดและผื่นกระจายอย่างไร หากไม่แน่ใจควรให้แพทย์ตรวจแยกจากผื่นชนิดอื่น',
  granuloma_annulare: 'บันทึกระยะเวลาและการเปลี่ยนแปลงของผื่นเป็นวง ให้แพทย์ตรวจยืนยัน ไม่เลือกยารักษาเชื้อราจากรูปร่างเป็นวงเพียงอย่างเดียว',
  folliculitis: 'แจ้งประวัติการโกนขน การเสียดสี และการใช้สระน้ำแก่แพทย์ หากไม่แน่ใจสาเหตุ ไม่ใช้ผลภาพเลือกยาฆ่าเชื้อเอง',
  tinea_unspecified: 'แจ้งตำแหน่งผื่นและการสัมผัสที่เกี่ยวข้องแก่แพทย์หรือเภสัชกร ผลกลุ่มนี้ไม่ระบุชนิดเชื้อหรือตำแหน่งย่อย จึงไม่ควรเลือกยาจากผลนี้อย่างเดียว',
  tinea_versicolor: 'หากมีปื้นสีผิวเปลี่ยน ควรให้แพทย์หรือเภสัชกรตรวจแยกสาเหตุอื่นก่อนเลือกการดูแล ไม่สรุปจากสีของปื้นเพียงอย่างเดียว',
  impetigo: 'หลีกเลี่ยงการแกะสะเก็ด ล้างมือ และไม่ใช้ผ้าเช็ดตัวร่วมกัน หากสงสัยภาวะนี้ควรปรึกษาแพทย์หรือเภสัชกรเพื่อประเมิน',
  molluscum_contagiosum: 'ไม่บีบหรือแกะตุ่ม หากไม่แน่ใจว่าเป็นตุ่มชนิดใด ให้แพทย์ตรวจแทนการกำจัดตุ่มด้วยตนเอง',
  herpes_simplex: 'แจ้งอาการแสบหรือยิบก่อนเกิดตุ่ม ตำแหน่ง และประวัติเป็นซ้ำแก่แพทย์ ภาพเดียวไม่ยืนยันชนิดไวรัส',
  herpes_zoster: 'หากมีตุ่มน้ำร่วมกับปวดหรือแสบ ควรรับการประเมินโดยเร็ว โดยเฉพาะผื่นใกล้ตา จมูก หรือมีการมองเห็นเปลี่ยน ไม่รอให้สแกนผ่านก่อนพบแพทย์',
  insect_bite: 'จดเวลาที่เริ่มมีอาการและประวัติสัมผัสแมลง หากมีปากหรือลิ้นบวม หรือหายใจลำบาก ให้ขอความช่วยเหลือฉุกเฉินทันที',
  pigmented_purpuric_eruption: 'บันทึกว่าจุดหรือจ้ำเริ่มเมื่อใดและเปลี่ยนแปลงอย่างไร ให้แพทย์ประเมินสาเหตุ ไม่ใช้ผลภาพสรุปว่าจ้ำเลือดไม่อันตราย',
  keratosis_pilaris: 'หลีกเลี่ยงการแกะ เกา หรือขัดผิวแรง หากคัน อักเสบ หรือไม่แน่ใจชนิดตุ่ม ควรปรึกษาแพทย์หรือเภสัชกร',
  lichen_simplex_chronicus: 'พยายามหลีกเลี่ยงการเกาหรือถูซ้ำ จดช่วงที่คันและสิ่งที่ระคายเคือง เพื่อให้แพทย์ประเมินสาเหตุของอาการคัน',
});
export const SCAN_CLASSES = Object.freeze([
  { id: 'acne_vulgaris', name: 'สิว', description: 'อาจพบสิวอุดตัน ตุ่มอักเสบหรือตุ่มหนอง บริเวณใบหน้า หน้าอก หรือหลัง', context: 'สิวอุดตันและตำแหน่งที่เป็นช่วยประกอบการประเมิน แต่ตุ่มคล้ายสิวอาจมีสาเหตุอื่น', source: 'https://www.nhs.uk/conditions/acne/' },
  { id: 'rosacea', name: 'โรซาเซีย', description: 'มักมีผิวหน้าแดงหรือร้อนวูบวาบ อาจมีตุ่มอักเสบและแสบผิว สีแดงอาจเห็นยากในผิวเข้ม', context: 'ประวัติหน้าแดงเป็นช่วง ๆ อาการแสบ และอาการทางตาเป็นข้อมูลที่ภาพเดียวบอกไม่ได้', source: 'https://www.nhs.uk/conditions/rosacea/' },
  { id: 'eczema_unspecified', name: 'ผื่นเอ็กซีมา ไม่ระบุชนิดย่อย', description: 'เป็นชื่อกลุ่มภาวะผิวแห้ง ระคายเคืองและคัน ไม่ได้หมายถึงภูมิแพ้ผิวหนังชนิดใดชนิดหนึ่งโดยเฉพาะ', context: 'ต้องใช้ประวัติ อาการ และการตรวจเพิ่มเติมเพื่อแยกชนิดย่อย ระบบไม่เปลี่ยนป้ายกำกับนี้เป็นภูมิแพ้ผิวหนังโดยอัตโนมัติ', source: 'https://www.nhs.uk/conditions/contact-dermatitis/' },
  { id: 'allergic_contact_dermatitis', name: 'ผื่นแพ้สัมผัส', description: 'ผื่นจากการตอบสนองต่อสารก่อภูมิแพ้ อาจคัน แห้ง แตก หรือมีตุ่มน้ำหลังสัมผัสสาร', context: 'ประวัติผลิตภัณฑ์หรือโลหะที่สัมผัสสำคัญ ภาพอย่างเดียวแยกจากผื่นระคายเคืองไม่ได้แน่นอน', source: 'https://www.nhs.uk/conditions/contact-dermatitis/' },
  { id: 'irritant_contact_dermatitis', name: 'ผื่นระคายเคืองสัมผัส', description: 'ผื่นจากสิ่งที่ทำให้ผิวชั้นนอกระคายเคือง เช่น สบู่หรือสารซักล้าง อาจแห้ง แตก คันหรือมีตุ่มน้ำ', context: 'ควรแจ้งชนิดสารและความถี่ที่สัมผัส ลักษณะอาจคล้ายผื่นแพ้สัมผัส', source: 'https://www.nhs.uk/conditions/contact-dermatitis/' },
  { id: 'psoriasis', name: 'สะเก็ดเงิน', description: 'มักเป็นปื้นแห้งมีสะเก็ด อาจคันหรือเจ็บ สีของปื้นต่างกันได้ตามสีผิว', context: 'ตำแหน่งผื่น เช่น ข้อศอก เข่า หรือหนังศีรษะ และการเปลี่ยนแปลงของเล็บช่วยประกอบการประเมิน', source: 'https://www.nhs.uk/conditions/psoriasis/' },
  { id: 'urticaria', name: 'ลมพิษ', description: 'ผื่นนูนคันเป็นตุ่มหรือปื้น มีรูปร่างและขนาดต่างกัน อาจแสบหรือร้อน', context: 'เวลาที่เริ่มเป็น การเปลี่ยนแปลงของผื่น และอาการร่วมสำคัญ ภาพถ่ายแสดงได้เพียงขณะหนึ่ง', source: 'https://www.nhs.uk/conditions/hives/' },
  { id: 'pityriasis_rosea', name: 'ผื่นกุหลาบ', description: 'อาจเริ่มจากปื้นกลมหรือรีมีขุยหนึ่งปื้น ก่อนมีผื่นขนาดเล็กกระจายตามลำตัว', context: 'ลำดับการเกิดผื่นช่วยแยกจากกลาก เอ็กซีมา หรือสะเก็ดเงิน ไม่ใช่เกลื้อน', source: 'https://www.nhs.uk/conditions/pityriasis-rosea/' },
  { id: 'granuloma_annulare', name: 'แกรนูโลมาแอนนูลาเร', description: 'อาจเห็นตุ่มนูนเรียงเป็นวง สีใกล้ผิว ชมพูหรือม่วง มักพบที่มือ เท้า หรือบริเวณข้อ', context: 'ผื่นเป็นวงไม่ได้หมายถึงเชื้อราเสมอ ต้องตรวจลักษณะและการเปลี่ยนแปลงร่วมกัน', source: 'https://www.nhs.uk/conditions/granuloma-annulare/' },
  { id: 'folliculitis', name: 'รูขุมขนอักเสบ', description: 'ตุ่มคล้ายสิวบริเวณรูขุมขน อาจคันหรือเจ็บ เกิดได้จากหลายสาเหตุ', context: 'ประวัติการโกนขน การเสียดสีหรือการใช้สระน้ำช่วยประกอบการประเมิน ไม่สามารถบอกเชื้อจากภาพอย่างเดียว', source: 'https://www.aad.org/public/diseases/a-z/folliculitis' },
  { id: 'tinea_unspecified', name: 'กลุ่มเชื้อราผิวหนัง ไม่ระบุชนิดย่อย', description: 'อาจเป็นผื่นคัน แห้งหรือมีขุย บางบริเวณมีลักษณะเป็นวง แต่รูปร่างเปลี่ยนไปตามตำแหน่งได้', context: 'ป้ายกำกับต้นทางไม่ระบุชนิดย่อย ระบบจึงไม่สรุปชื่อเชื้อหรือตำแหน่งย่อยให้เอง', source: 'https://www.nhs.uk/conditions/ringworm/' },
  { id: 'tinea_versicolor', name: 'เกลื้อน', description: 'เป็นปื้นสีผิวเปลี่ยน อาจอ่อนหรือเข้มกว่าผิวรอบข้าง มีขุยละเอียดและอาจคัน', context: 'มักพบบริเวณอก หลังส่วนบน หรือต้นแขน ไม่ใช่ผื่นกุหลาบ และปื้นสีเปลี่ยนมีสาเหตุอื่นได้', source: 'https://www.nhs.uk/conditions/pityriasis-versicolor/' },
  { id: 'impetigo', name: 'พุพอง', description: 'อาจเริ่มจากแผลหรือตุ่มน้ำที่แตกแล้วเกิดสะเก็ดสีเหลืองน้ำตาล มักพบรอบจมูก ปาก หรือมือ', context: 'ตุ่มน้ำและสะเก็ดอาจคล้ายเริมหรือผื่นชนิดอื่น ต้องประเมินอาการและการลุกลามร่วมด้วย', source: 'https://www.nhs.uk/conditions/impetigo/' },
  { id: 'molluscum_contagiosum', name: 'หูดข้าวสุก', description: 'อาจมีตุ่มกลมเล็ก ผิวมันวาวและรอยบุ๋มตรงกลาง เป็นภาวะที่แพร่ผ่านการสัมผัสได้', context: 'ตุ่มขนาดเล็กหลายสาเหตุมีหน้าตาคล้ายกัน หากไม่แน่ใจควรให้แพทย์ตรวจ', source: 'https://www.nhs.uk/conditions/molluscum-contagiosum/' },
  { id: 'herpes_simplex', name: 'เริม', description: 'อาจมีอาการยิบ ๆ คันหรือแสบร้อนก่อนเกิดตุ่มน้ำเจ็บ แล้วแตกเป็นสะเก็ด ตัวอย่างที่พบบ่อยคือบริเวณริมฝีปาก', context: 'ตำแหน่ง อาการก่อนเกิดตุ่ม และประวัติเป็นซ้ำช่วยประกอบการประเมิน ภาพไม่ยืนยันเชื้อไวรัส', source: 'https://www.nhs.uk/conditions/cold-sores/' },
  { id: 'herpes_zoster', name: 'งูสวัด', description: 'อาจมีปวดหรือรู้สึกยิบ ๆ ก่อนเกิดผื่นตุ่มน้ำ ซึ่งมักอยู่ด้านใดด้านหนึ่งของร่างกาย', context: 'ตำแหน่งและอาการปวดสำคัญ หากมีผื่นใกล้ตาหรือการมองเห็นเปลี่ยนควรพบแพทย์โดยเร็ว', source: 'https://www.nhs.uk/conditions/shingles/' },
  { id: 'insect_bite', name: 'ผื่นจากแมลงกัดต่อย', description: 'อาจเป็นตุ่มบวมเล็ก มีอาการเจ็บหรือคัน และอาจมีจุดที่ถูกกัดหรือต่อย', context: 'ประวัติสัมผัสแมลงสำคัญ ภาพอย่างเดียวไม่ยืนยันชนิดแมลงหรือสาเหตุของตุ่ม', source: 'https://www.nhs.uk/conditions/insect-bites-and-stings/' },
  { id: 'pigmented_purpuric_eruption', name: 'ผื่นจ้ำเลือดมีเม็ดสี', description: 'อาจเป็นจุดแดงเล็ก ๆ รวมเป็นปื้นสีน้ำตาลแดง สัมพันธ์กับเลือดที่รั่วจากหลอดเลือดฝอยในผิว', context: 'จ้ำเลือดมีได้หลายสาเหตุ ระบบไม่ใช้ภาพเพื่อยืนยันว่าเป็นชนิดที่ไม่อันตราย', source: 'https://www.pcds.org.uk/clinical-guidance/capillaritis' },
  { id: 'keratosis_pilaris', name: 'ขนคุด', description: 'ตุ่มเล็กจำนวนมากทำให้ผิวสัมผัสสาก มักอยู่ต้นแขน ต้นขา หรือก้น สีอาจเหมือนหรือเข้มกว่าผิว', context: 'ตำแหน่งและผิวสัมผัสช่วยประกอบการประเมิน ความหยาบของผิวตรวจจากภาพอย่างเดียวได้จำกัด', source: 'https://www.nhs.uk/conditions/keratosis-pilaris/' },
  { id: 'lichen_simplex_chronicus', name: 'ผื่นหนาจากการเกาเรื้อรัง', description: 'ผิวเป็นปื้นหนาและเห็นลายผิวชัดขึ้นจากวงจรคันและเกาหรือถูซ้ำ ๆ', context: 'ประวัติอาการคันและการเกาช่วยประกอบการประเมิน ไม่สรุปสาเหตุอาการคันจากภาพเดียว', source: 'https://bad.org.uk/pils/lichen-simplex' },
].map(item => Object.freeze({ ...item, recommendation: CLASS_GUIDANCE[item.id] })));

export const SCAN_MESSAGES = Object.freeze({
  OUT_OF_SCOPE: 'ข้อมูลผิดพลาด กรุณาใช้ภาพรอยโรคผิวหนังของมนุษย์ที่เห็นบริเวณรอยโรคชัดเจน ไม่ใช้ภาพสิ่งของ สัตว์ อาหาร เอกสาร ภาพหน้าจอ วิว หรือภาพอื่นที่ไม่เกี่ยวข้อง',
  UNCERTAIN_CONTENT: 'ระบบยังตรวจสอบไม่ได้อย่างมั่นใจว่าเป็นภาพรอยโรคผิวหนัง จึงหยุดการจำแนก กรุณาถ่ายภาพรอยโรคให้ชัดเจนแล้วลองใหม่',
  UNSUPPORTED_LESION: 'ขออภัย ระบบยังไม่รองรับหรือไม่สามารถจำแนกรอยโรคในภาพนี้ได้อย่างน่าเชื่อถือ จึงไม่ระบุชื่อรอยโรค โปรดพบแพทย์ผู้เชี่ยวชาญด้านผิวหนังเพื่อรับการประเมิน',
  UNCERTAIN_CLASSIFICATION: 'ระบบยังแยกกลุ่มรอยโรคในภาพนี้ได้ไม่ชัดเจน จึงไม่แสดงชื่อกลุ่มที่อาจทำให้เข้าใจผิด โปรดพบแพทย์ผู้เชี่ยวชาญด้านผิวหนังเพื่อรับการประเมิน',
  MODEL_UNAVAILABLE: 'ระบบวิเคราะห์และคัดกรองภาพรอยโรคยังไม่พร้อมใช้งาน จึงยังไม่สามารถจำแนกภาพนี้ได้ กรุณาลองใหม่เมื่อระบบพร้อม',
  INVALID_MODEL_RESULT: 'ระบบได้รับผลวิเคราะห์ไม่ครบถ้วน จึงยังไม่แสดงชื่อรอยโรค กรุณาลองใหม่ภายหลัง',
});
export const SCAN_DISCLAIMER = 'เป็นการวิเคราะห์และจำแนกลักษณะรอยโรคจากภาพ ไม่ใช่การวินิจฉัยโดยแพทย์ ข้อมูลเปรียบเทียบเป็นความรู้ทั่วไป ไม่ใช่สิ่งที่ระบบยืนยันว่าพบในภาพของคุณ และไม่ควรใช้ตัดสินใจรักษาด้วยตนเอง';

// A presentation contract, not a model or an authorization check. The API must
// produce this only from trusted inference, never from a user-supplied score.
export function scanResultView(result) {
  const reject = code => ({ code, title: code === 'UNSUPPORTED_LESION' ? 'รอยโรคนี้ยังไม่อยู่ในขอบเขตที่ระบบจำแนกได้' : code === 'OUT_OF_SCOPE' ? 'ข้อมูลผิดพลาด' : 'ยังไม่สามารถสรุปผลได้', message: SCAN_MESSAGES[code], candidates: [] });
  if (Object.hasOwn(SCAN_MESSAGES, result?.code)) return reject(result.code);
  if (!['CLASSIFIED', 'COMPARE_SUPPORTED'].includes(result?.code) || result?.scope !== 'supported_skin_lesion') return reject('INVALID_MODEL_RESULT');
  const expected = result.code === 'COMPARE_SUPPORTED' ? 2 : 1;
  if (!Array.isArray(result.candidates) || result.candidates.length !== expected) return reject('INVALID_MODEL_RESULT');
  const seen = new Set();
  const candidates = [];
  for (const candidate of result.candidates) {
    const item = SCAN_CLASSES.find(entry => entry.id === candidate?.id);
    if (!item || seen.has(item.id)) return reject('INVALID_MODEL_RESULT');
    seen.add(item.id);
    // Do not display uncalibrated softmax numbers as disease probabilities.
    candidates.push(item);
  }
  return { code: result.code,
    title: expected === 2 ? 'ลักษณะใกล้เคียง 2 กลุ่ม — ยังไม่สรุปว่าเป็นกลุ่มใด' : 'กลุ่มลักษณะที่โมเดลจัดไว้ใกล้เคียง',
    message: expected === 2 ? 'เปรียบเทียบคำอธิบายทั่วไปของทั้งสองกลุ่มด้านล่าง ผลนี้ไม่ยืนยันว่าคุณเป็นโรคใดโรคหนึ่งหรือทั้งสองโรค ควรให้แพทย์ประเมินเพิ่มเติม' : 'ชื่อกลุ่มนี้เป็นผลจัดประเภทจากโมเดล ไม่ใช่คำยืนยันว่าคุณเป็นโรคนี้',
    candidates,
  };
}

export function renderScanResult(container, result) {
  const view = scanResultView(result);
  const doc = container.ownerDocument;
  const element = (tag, text, css) => {
    const node = doc.createElement(tag);
    node.textContent = text;
    if (css) node.className = css;
    return node;
  };
  container.replaceChildren();
  container.dataset.resultCode = view.code;
  container.append(element('h3', view.title, 'text-base font-extrabold text-white'), element('p', view.message, 'mt-2 text-xs leading-relaxed text-slate-200'));
  const grid = element('div', '', 'mt-4 grid gap-3 sm:grid-cols-2');
  for (const item of view.candidates) {
    const card = element('section', '', 'rounded-2xl border border-teal-300/25 bg-slate-950/30 p-4');
    card.append(element('h4', item.name, 'font-bold text-teal-200'),
      element('p', 'ลักษณะทั่วไป', 'mt-3 text-xs font-bold text-slate-200'),
      element('p', item.description, 'mt-1 text-xs leading-relaxed text-slate-300'),
      element('p', 'ข้อมูลที่ช่วยแยกเพิ่มเติม', 'mt-3 text-xs font-bold text-slate-200'),
      element('p', item.context, 'mt-1 text-xs leading-relaxed text-slate-300'));
    const source = element('a', 'อ่านข้อมูลจากแหล่งอ้างอิง', 'mt-3 inline-block text-xs text-cyan-200 underline');
    source.href = item.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.referrerPolicy = 'no-referrer';
    card.append(source); grid.append(card);
  }
  if (view.candidates.length) container.append(grid);
  container.append(element('p', SCAN_DISCLAIMER, 'mt-4 rounded-xl border border-amber-200/25 bg-amber-400/10 p-3 text-xs leading-relaxed text-amber-100'));
  container.classList.remove('hidden');
  return view;
}
