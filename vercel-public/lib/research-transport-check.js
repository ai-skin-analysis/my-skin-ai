// An engineering probe, not a scan or a medical evaluation. These pixels are
// generated colored squares, not a person or a dataset/user photograph.
import { researchInferenceFromEnvironment } from './research-inference.js';
const GENERATED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAOAAAADgCAIAAACVT/22AAAC30lEQVR4nO3csW3DQBQFQdK1uCDV4YJcnWK3IXVwH3QgLnAzscTgsOAlxDuPx/O44vX7fen354/nO5//9/N16dfwYQIlTaCkCZQ0gZImUNIESppASRMoaQIlTaCkCZQ0gZImUNIEStr5+rv4B993Op8Pfh/sDUqaQEkTKGkCJU2gpAmUNIGSJlDSBEqaQEkTKGkCJU2gpAmUNIGSdtoHHQ7I96+3no83KGkCJU2gpAmUNIGSJlDSBEqaQEkTKGkCJU2gpAmUNIGSJlDSBEqafdCb9y89f80blDSBkiZQ0gRKmkBJEyhpAiVNoKQJlDSBkiZQ0gRKmkBJEyhpAiXNPuh0QL7vXLIPytZc8aQJlDSBkiZQ0gRKmkBJEyhpAiVNoKQJlDSBkiZQ0gRKmkBJsw86sN957/l4g5ImUNIESppASRMoaQIlTaCkCZQ0gZImUNIESppASRMoaQIlTaCk2QedDsg+6JJ9ULbmiidNoKQJlDSBkiZQ0gRKmkBJEyhpAiVNoKQJlDSBkiZQ0gRKmn3QgX3QNfugbM0VT5pASRMoaQIlTaCkCZQ0gZImUNIESppASRMoaQIlTaCkCZQ0+6DTAdkHXbIPytZc8aQJlDSBkiZQ0gRKmkBJEyhpAiVNoKQJlDSBkiZQ0gRKmkBJsw86sA+6Zh+UrbniSRMoaQIlTaCkCZQ0gZImUNIESppASRMoaQIlTaCkCZQ0gZJmH3Q6IPugS/ZB2ZornjSBkiZQ0gRKmkBJEyhpAiVNoKQJlDSBkiZQ0gRKmkBJEyhp9kEH9kHX7IOyNVc8aQIlTaCkCZQ0gZImUNIESppASRMoaQIlTaCkCZQ0gZImUNLsg04HZB90yT4oW3PFkyZQ0gRKmkBJEyhpAiVNoKQJlDSBkiZQ0gRKmkBJEyhpAiXNPujAPuiafVC25oonTaCkCZQ0gZImUNIESppASRMoaQIlTaCkCZQ0gZImUNIEylH2BuufKDnCseBnAAAAAElFTkSuQmCC';

export async function researchTransportCheck(client = researchInferenceFromEnvironment()) {
  const ready = await client.readiness();
  // The validated client still enforces TLS, the exact version/labels, consent,
  // bounded responses, no redirects, and all experimental-only flags.
  await client.analyze(Buffer.from(GENERATED_PNG, 'base64'), { consent: true });
  return { ok: true, transportAvailable: true, modelVersion: ready.modelVersion,
    classCount: ready.classCount, generatedProbeOnly: true, userImageSent: false,
    publicReleaseApproved: false };
}
