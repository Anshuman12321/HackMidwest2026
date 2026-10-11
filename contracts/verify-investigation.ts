import { readFileSync } from 'node:fs';
import { InvestigationRequestSchema, InvestigationResponseSchema } from './investigation.ts';
import { RetrievalSchema, validateEvidence } from './investigate.server.ts';

const [responsePath, capturePath] = process.argv.slice(2);
if (!responsePath || !capturePath) throw new Error('Usage: node verify-investigation.ts <response.json> <capture.json>');
const response = InvestigationResponseSchema.parse(JSON.parse(readFileSync(responsePath, 'utf8')));
const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
const request = InvestigationRequestSchema.parse(capture.request);
const retrieved = RetrievalSchema.parse(capture.retrieved);
if (response.request_id !== request.request_id || response.outcome.statement !== request.outcome) throw new Error('Captured request differs from response');
validateEvidence(response, retrieved);
console.log(`Verified ${response.context_bundle.evidence.length} exact source citations and the shared runtime contract/plan digest.`);
