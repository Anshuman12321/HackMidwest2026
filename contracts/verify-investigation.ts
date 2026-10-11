import { readFileSync } from 'node:fs';
import { InvestigationRequestSchema, InvestigationResponseSchema } from './investigation.ts';
import { canonicalJson } from './review.server.ts';
import { RetrievalSchema, validateEvidence } from './investigate.server.ts';

const [responsePath, capturePath] = process.argv.slice(2);
if (!responsePath || !capturePath) throw new Error('Usage: node verify-investigation.ts <response.json> <capture.json>');
const response = InvestigationResponseSchema.parse(JSON.parse(readFileSync(responsePath, 'utf8')));
const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
const request = InvestigationRequestSchema.parse(capture.request);
const retrieved = RetrievalSchema.parse(capture.retrieved);
if (response.request_id !== request.request_id || response.outcome.statement !== request.outcome ||
    canonicalJson(response.outcome.constraints) !== canonicalJson(request.constraints) ||
    (request.reference_time && response.outcome.reference_time !== request.reference_time))
  throw new Error('Captured request differs from response');
const starting = request.scope_hints.starting_object;
if (starting && !response.context_bundle.entities.some(e => e.kind === 'issue' && e.native?.id === starting.id &&
    e.native.display_id === starting.display_id)) throw new Error('Captured starting issue is missing or changed');
validateEvidence(response, retrieved);
console.log(`Verified ${response.context_bundle.evidence.length} captured source citations and the v2 contract/plan digest; this does not assert fresh native access.`);
