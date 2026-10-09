// Six PAD labels are a different domain, never a relabelled SCIN-20 output.
import { SCAN_CLASSES } from './scan-result.js';

// Exactly the original trained three-label artifact, not arbitrary truncated
// scores from a twenty- or six-label classifier.
export const SCIN3_MODEL_VERSION = 'scin3-local-baab96df5bf5';
export const SCIN3_CLASSES = Object.freeze(['acne_vulgaris', 'psoriasis', 'urticaria']
  .map(id => SCAN_CLASSES.find(row => row.id === id)));

const CAUTION = 'ชื่อกลุ่มเป็นผลจัดประเภทเชิงทดลอง ไม่ยืนยันหรือคัดโรคมะเร็งออก หากรอยโรคเปลี่ยนแปลง โตขึ้น เป็นแผลหรือเลือดออก ควรพบแพทย์ อย่าใช้ผลนี้เลือกยาหรือรักษาเอง';
export const PAD6_CLASSES = Object.freeze([
  { id: 'actinic_keratosis', name: 'กระแดด (Actinic keratosis)', description: 'อาจเป็นปื้นแห้ง หยาบหรือมีขุยบริเวณที่โดนแดด สีและลักษณะอาจต่างกันได้', context: 'ภาพเดียวไม่ยืนยันชนิดรอยโรคหรือการเปลี่ยนแปลงของเซลล์ ควรให้แพทย์ตรวจเมื่อสงสัย', source: 'https://www.nhs.uk/conditions/actinic-keratoses/' },
  { id: 'basal_cell_carcinoma', name: 'กลุ่มมะเร็งผิวหนังชนิดเบซัลเซลล์ (BCC)', description: 'อาจเป็นก้อนหรือปื้นผิดปกติ มีผิวเรียบ ขรุขระ สะเก็ดหรือสีผิวเปลี่ยน ลักษณะแตกต่างกันได้', context: 'เป็นชื่อป้ายกำกับในชุดข้อมูล ไม่ใช่การวินิจฉัยมะเร็งจากภาพที่ส่ง ต้องประเมินโดยแพทย์', source: 'https://www.nhs.uk/conditions/non-melanoma-skin-cancer/symptoms/' },
  { id: 'melanoma', name: 'กลุ่มเมลาโนมา (Melanoma)', description: 'อาจเกี่ยวข้องกับไฝหรือรอยใหม่ที่เปลี่ยนขนาด รูปร่างหรือสี ขอบหรือสีไม่สม่ำเสมอ แต่ไม่จำเป็นต้องมีทุกลักษณะ', context: 'ผลกลุ่มอื่นไม่ได้ตัดเมลาโนมาออก ชุดฝึกนี้มีตัวอย่างกลุ่มนี้น้อย จึงต้องระวังผลพลาดเป็นพิเศษ', source: 'https://www.nhs.uk/conditions/melanoma-skin-cancer/symptoms/' },
  { id: 'melanocytic_nevus', name: 'ไฝ (Nevus)', description: 'ไฝเป็นรอยบนผิวที่พบได้ทั่วไป อาจแบนหรือนูน มีสีและขนาดแตกต่างกันได้', context: 'ผลจัดเป็นไฝไม่รับรองว่าไม่อันตราย หากเป็นรอยใหม่ เปลี่ยนขนาด รูปร่างหรือสี คัน เจ็บ หรือเลือดออก ควรพบแพทย์', source: 'https://www.nhs.uk/conditions/moles/' },
  { id: 'squamous_cell_carcinoma', name: 'กลุ่มมะเร็งผิวหนังชนิดสความัสเซลล์ (SCC)', description: 'อาจเป็นก้อนหรือปื้นผิดปกติ ขรุขระ มีสะเก็ดหรือสีเปลี่ยน ภาพไม่สามารถยืนยันชนิดเซลล์ได้', context: 'ป้ายกำกับ PAD นี้รวม Bowen disease หรือ SCC in situ ตามผู้จัดทำ ไม่แยกระยะหรือความรุนแรง', source: 'https://www.nhs.uk/conditions/non-melanoma-skin-cancer/symptoms/' },
  { id: 'seborrheic_keratosis', name: 'กระเนื้อ (Seborrheic keratosis)', description: 'อาจเป็นรอยนูนผิวคล้ายขี้ผึ้งหรือหูด สีตั้งแต่อ่อนไปเข้ม ลักษณะอาจคล้ายรอยโรคชนิดอื่น', context: 'ผลกลุ่มนี้ไม่ยืนยันว่ารอยโรคปลอดภัย เพราะลักษณะอาจคล้ายมะเร็งผิวหนัง ไม่ควรตัดหรือจี้ออกเอง', source: 'https://www.aad.org/public/diseases/a-z/seborrheic-keratoses-overview' },
].map(row => Object.freeze({ ...row, recommendation: CAUTION })));

export function researchClassesForVersion(version) {
  if (version === SCIN3_MODEL_VERSION) return SCIN3_CLASSES;
  if (/^pad6-local-[0-9a-f]{12}$/.test(version || '')) return PAD6_CLASSES;
  // Legacy results keep their own labels; never map old scores onto six names.
  if (/^derm-local-[0-9a-f]{12}$/.test(version || '')) return SCAN_CLASSES;
  return null;
}
