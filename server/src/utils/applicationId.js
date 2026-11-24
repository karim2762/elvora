import { newElvoraId, idMatcher } from './elvoraId.js';

// Application IDs are the single Elvora ID of the journey (ELV-7K3Q9XMD). Legacy IDs (ELV-APP-7K3Q9XMD) still work.
export const newApplicationId = () => newElvoraId();
export const APPLICATION_ID_RE = idMatcher('APP');
