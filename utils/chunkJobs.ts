/**
 * Split a stored job into text chunks for embedding (architecture 2026-07-15:
 * chunk-level BGE-M3 vectors stored on the chunk row in job_chunks).
 *
 * Chunk plan per job:
 *   - 'summary'            — one line of title/category/labor type/location,
 *                            cheap high-signal chunk for matching
 *   - 'description'        — the posting description (split if very long)
 *   - 'additional-details' — buyer's free-text "Additional Job Details",
 *                            skipped when it duplicates the description
 *
 * Compliance boilerplate that is identical across postings (furlough policy,
 * driving-record text, NERC/nuclear notes) is deliberately NOT chunked — it
 * carries no matching signal and would only pollute similarity search.
 */

export interface ChunkableJob {
  job_id: string;
  title: string | null;
  client: string | null;
  site: string | null;
  location: string | null;
  category: string | null;
  labor_type: string | null;
  description: string | null;
  details: Record<string, string> | null;
}

export interface JobChunk {
  source: string;
  content: string;
}

/** BGE-M3 accepts 8192 tokens (~24k chars); stay well under with margin. */
const MAX_CHUNK_CHARS = 4000;

/** Split long text on sentence boundaries into <= MAX_CHUNK_CHARS pieces. */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const parts: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length + 1 > MAX_CHUNK_CHARS && buf) {
      parts.push(buf.trim());
      buf = '';
    }
    buf += (buf ? ' ' : '') + s;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

export function chunkJob(job: ChunkableJob): JobChunk[] {
  const chunks: JobChunk[] = [];

  const summaryBits = [
    job.title,
    job.category && `Category: ${job.category}`,
    job.labor_type && `Labor type: ${job.labor_type}`,
    job.location && `Location: ${job.location}`,
    job.client && `Client: ${job.client}`,
  ].filter(Boolean);
  if (summaryBits.length > 0) {
    chunks.push({ source: 'summary', content: summaryBits.join('. ') });
  }

  const description = (job.description ?? '').trim();
  for (const part of description ? splitLongText(description) : []) {
    chunks.push({ source: 'description', content: part });
  }

  const additional = (job.details?.['Additional Job Details'] ?? '').trim();
  // Skip when empty or when the buyer pasted the same text into both fields.
  if (additional && !description.includes(additional) && !additional.includes(description)) {
    for (const part of splitLongText(additional)) {
      chunks.push({ source: 'additional-details', content: part });
    }
  }

  return chunks;
}
