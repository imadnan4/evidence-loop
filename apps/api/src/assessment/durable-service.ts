import { randomUUID } from "node:crypto";
import type { CreateAssessmentDraftRequest } from "@evidence-loop/contracts/v1";
import { fingerprintRequest, IdempotencyConflictError, reserveIdempotencyKey, withTenantTransaction, writeWithAuditAndOutbox } from "@evidence-loop/db";
import type { Sql, TransactionSql } from "postgres";
import type { Principal } from "../auth/principal.ts";
import { AssessmentHttpError, ValidationError } from "./durable-errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_SQL = new Set(["instructor", "course_admin"]);
type VersionRow = { id:string; assessment_id:string; course_id:string; title:string; state:"draft"|"published"; version_number:number; assignment_instructions:string; learner_facing_text:string; ai_use_policy:"allowed"|"allowed_with_disclosure"|"not_allowed"; privacy_summary:string; completion_criteria:string; text_check_in:boolean; voice_check_in:boolean; extra_time:boolean; pause_and_resume:boolean; alternative_assessment_request:boolean; question_budget:number; time_budget_minutes:number; created_at:Date; published_at:Date|null };

function ensureUuid(value:string, label:string) { if (!UUID.test(value)) throw new ValidationError(`${label} must be a UUID.`); }
function key(value:string|undefined) { if (!value || !/^[A-Za-z0-9._:-]{1,255}$/.test(value)) throw new ValidationError("A valid Idempotency-Key header is required."); return value; }
async function manager(tx:TransactionSql, p:Principal, courseId:string) {
  const rows=await tx<{role:string}[]>`SELECT role FROM course_memberships WHERE organization_id=${p.organizationId} AND course_id=${courseId} AND user_id=${p.userId}`;
  if (!rows[0] || !ROLE_SQL.has(rows[0].role)) throw new AssessmentHttpError(404,"not_found","Resource not found.");
}
async function member(tx:TransactionSql,p:Principal,courseId:string) {
  const rows=await tx`SELECT 1 FROM course_memberships WHERE organization_id=${p.organizationId} AND course_id=${courseId} AND user_id=${p.userId}`;
  if (!rows.length) throw new AssessmentHttpError(404,"not_found","Resource not found.");
}
function recordToDto(row:VersionRow, objectives:any[], rubric:any[]) {
  return { id:row.id, assessment_id:row.assessment_id, course_id:row.course_id, title:row.title, state:row.state, version:row.version_number,
    assignment_instructions:row.assignment_instructions, policy:{learner_facing_text:row.learner_facing_text,ai_use_policy:row.ai_use_policy,privacy_summary:row.privacy_summary,completion_criteria:row.completion_criteria},
    accommodations:{text_check_in:row.text_check_in,voice_check_in:row.voice_check_in,extra_time:row.extra_time,pause_and_resume:row.pause_and_resume,alternative_assessment_request:row.alternative_assessment_request},question_budget:row.question_budget,time_budget_minutes:row.time_budget_minutes,created_at:row.created_at.toISOString(),published_at:row.published_at?.toISOString()??null,objectives,rubric };
}
async function loadVersion(tx:TransactionSql, org:string, versionId:string, onlyPublished=false) {
  const rows = onlyPublished
    ? await tx<VersionRow[]>`SELECT * FROM assessment_versions WHERE organization_id=${org} AND id=${versionId} AND state = 'published'`
    : await tx<VersionRow[]>`SELECT * FROM assessment_versions WHERE organization_id=${org} AND id=${versionId}`;
  const row=rows[0]; if(!row) throw new AssessmentHttpError(404,"not_found","Resource not found.");
  const objectives=await tx<any[]>`SELECT id,label,description,evidence_criteria,assessable_in_check_in,position FROM assessment_objectives WHERE organization_id=${org} AND assessment_version_id=${row.id} ORDER BY position`;
  const criteria=await tx<any[]>`SELECT id,label,description,evidence_criteria,position FROM rubric_criteria WHERE organization_id=${org} AND assessment_version_id=${row.id} ORDER BY position`;
  const mappings=await tx<any[]>`SELECT criterion_id,objective_id FROM rubric_criterion_objectives WHERE organization_id=${org} AND assessment_version_id=${row.id}`;
  const map=new Map<string,string[]>(); for(const m of mappings) map.set(m.criterion_id,[...(map.get(m.criterion_id)??[]),m.objective_id]);
  return recordToDto(row,objectives.map(o=>({id:o.id,label:o.label,description:o.description,evidence_criteria:o.evidence_criteria,assessable_in_check_in:o.assessable_in_check_in})),criteria.map(c=>({id:c.id,label:c.label,description:c.description,evidence_criteria:c.evidence_criteria,objective_ids:map.get(c.id)??[]})));
}

export class DurableAssessmentService {
  private readonly client: Sql<{}>;
  constructor(client: Sql<{}>) { this.client = client; }
  async createInitialDraft(principal:Principal, courseId:string, body:CreateAssessmentDraftRequest, header:string|undefined) {
    ensureUuid(courseId,"courseId"); const idempotencyKey=key(header); for(const o of body.objectives) ensureUuid(o.id,"objective id");
    const operation="assessment.create_initial"; const fingerprint=fingerprintRequest({operation,courseId,body});
    return withTenantTransaction(this.client,{organizationId:principal.organizationId,actorId:principal.userId,correlationId:principal.correlationId},async tx=>{
      await manager(tx,principal,courseId); const reserved=await reserveIdempotencyKey(tx,{organizationId:principal.organizationId,operation,key:idempotencyKey,requestFingerprint:fingerprint});
      if(reserved==="replayed") { const result=await tx<{target_id:string}[]>`SELECT target_id FROM idempotency_results WHERE organization_id=${principal.organizationId} AND operation=${operation} AND key=${idempotencyKey}`; if(!result[0]) throw new Error("idempotency result missing"); const assessment=await tx<{current_published_version_id:string|null}[]>`SELECT current_published_version_id FROM assessments WHERE organization_id=${principal.organizationId} AND id=${result[0].target_id}`; return {replayed:true,status:201,assessment_id:result[0].target_id,draft: await loadVersion(tx,principal.organizationId,(await tx<{id:string}[]>`SELECT id FROM assessment_versions WHERE organization_id=${principal.organizationId} AND assessment_id=${result[0].target_id} ORDER BY version_number LIMIT 1`)[0]!.id)}; }
      const assessmentId=randomUUID(); const versionId=randomUUID();
      await writeWithAuditAndOutbox(tx,{organizationId:principal.organizationId,actorId:principal.userId,correlationId:principal.correlationId,audit:{action:"assessment.created",targetType:"assessment",targetId:assessmentId,metadata:{source:"instructor",outcome:"accepted"}},outbox:{aggregateType:"assessment",aggregateId:assessmentId,topic:"assessment.created",payload:{assessment_id:assessmentId,version_id:versionId}},domainWrite:async inner=>{
        await inner`INSERT INTO assessments (id,organization_id,course_id,title) VALUES (${assessmentId},${principal.organizationId},${courseId},${body.title})`;
        await inner`INSERT INTO assessment_versions (id,organization_id,course_id,assessment_id,version_number,title,assignment_instructions,learner_facing_text,ai_use_policy,privacy_summary,completion_criteria,text_check_in,voice_check_in,extra_time,pause_and_resume,alternative_assessment_request,question_budget,time_budget_minutes,created_by) VALUES (${versionId},${principal.organizationId},${courseId},${assessmentId},1,${body.title},${body.assignment_instructions},${body.policy.learner_facing_text},${body.policy.ai_use_policy},${body.policy.privacy_summary},${body.policy.completion_criteria},${body.accommodations.text_check_in},${body.accommodations.voice_check_in},${body.accommodations.extra_time},${body.accommodations.pause_and_resume},${body.accommodations.alternative_assessment_request},${body.question_budget},${body.time_budget_minutes},${principal.userId})`;
        for(const [i,o] of body.objectives.entries()) await inner`INSERT INTO assessment_objectives (id,organization_id,assessment_id,assessment_version_id,position,label,description,evidence_criteria,assessable_in_check_in,approved_by) VALUES (${o.id},${principal.organizationId},${assessmentId},${versionId},${i+1},${o.label},${o.description},${o.evidence_criteria},${o.assessable_in_check_in},${principal.userId})`;
        for(const [i,r] of body.rubric.entries()) { const criterion=(await inner<{id:string}[]>`INSERT INTO rubric_criteria (organization_id,assessment_id,assessment_version_id,position,label,description,evidence_criteria) VALUES (${principal.organizationId},${assessmentId},${versionId},${i+1},${r.label},${r.description},${r.evidence_criteria}) RETURNING id`)[0]!; for(const objectiveId of r.objective_ids) await inner`INSERT INTO rubric_criterion_objectives (organization_id,assessment_version_id,criterion_id,objective_id) VALUES (${principal.organizationId},${versionId},${criterion.id},${objectiveId})`; }
        await inner`INSERT INTO idempotency_results (organization_id,operation,key,target_type,target_id) VALUES (${principal.organizationId},${operation},${idempotencyKey},'assessment',${assessmentId})`;
      }});
      return {replayed:false,status:201,assessment_id:assessmentId,draft:await loadVersion(tx,principal.organizationId,versionId)};
    }).catch((error) => {
      if (error instanceof IdempotencyConflictError) {
        throw new AssessmentHttpError(409, "idempotency_conflict", "Idempotency key conflicts with a different request.");
      }
      throw error;
    });
  }
  async publish(principal:Principal,versionId:string,header:string|undefined) {
    ensureUuid(versionId,"versionId"); const idempotencyKey=key(header); const operation="assessment.publish"; const fingerprint=fingerprintRequest({operation,versionId});
    return withTenantTransaction(this.client,{organizationId:principal.organizationId,actorId:principal.userId,correlationId:principal.correlationId},async tx=>{
      const version=(await tx<VersionRow[]>`SELECT * FROM assessment_versions WHERE organization_id=${principal.organizationId} AND id=${versionId} FOR UPDATE`)[0]; if(!version) throw new AssessmentHttpError(404,"not_found","Resource not found."); await manager(tx,principal,version.course_id); const reserved=await reserveIdempotencyKey(tx,{organizationId:principal.organizationId,operation,key:idempotencyKey,requestFingerprint:fingerprint});
      if(reserved==="replayed") return {replayed:true,status:200,published:await loadVersion(tx,principal.organizationId,versionId,true)};
      if(version.state!=="draft") throw new AssessmentHttpError(409,"conflict","Assessment version is not a draft.");
      const counts=(await tx<{assessable:string; mapped:string; criteria:string}[]>`SELECT (SELECT count(*) FROM assessment_objectives WHERE organization_id=${principal.organizationId} AND assessment_version_id=${versionId} AND assessable_in_check_in)::text assessable, (SELECT count(*) FROM rubric_criteria c WHERE organization_id=${principal.organizationId} AND assessment_version_id=${versionId} AND EXISTS (SELECT 1 FROM rubric_criterion_objectives m WHERE m.criterion_id=c.id))::text mapped, (SELECT count(*) FROM rubric_criteria WHERE organization_id=${principal.organizationId} AND assessment_version_id=${versionId})::text criteria`)[0]!;
      if(Number(counts.assessable)<3||Number(counts.assessable)>5||Number(counts.criteria)<1||Number(counts.mapped)!==Number(counts.criteria)) throw new AssessmentHttpError(409,"conflict","Draft does not meet publication requirements.");
      await tx`UPDATE assessment_versions SET state='published',published_by=${principal.userId},published_at=now() WHERE organization_id=${principal.organizationId} AND id=${versionId}`;
      await tx`UPDATE assessments SET current_published_version_id=${versionId},state='published',updated_at=now() WHERE organization_id=${principal.organizationId} AND id=${version.assessment_id}`;
      await tx`INSERT INTO idempotency_results (organization_id,operation,key,target_type,target_id) VALUES (${principal.organizationId},${operation},${idempotencyKey},'assessment_version',${versionId})`;
      await tx`INSERT INTO audit_events (organization_id,actor_id,correlation_id,action,target_type,target_id,metadata) VALUES (${principal.organizationId},${principal.userId},${principal.correlationId},'assessment.version_published','assessment_version',${versionId},${tx.json({ source: "instructor", outcome: "completed" })})`;
      await tx`INSERT INTO outbox_events (organization_id,aggregate_type,aggregate_id,topic,payload) VALUES (${principal.organizationId},'assessment_version',${versionId},'assessment.version_published',${tx.json({ assessment_id: version.assessment_id, version_id: versionId, state: "published" })})`;
      return {replayed:false,status:200,published:await loadVersion(tx,principal.organizationId,versionId,true)};
    }).catch(error=>{if(error instanceof IdempotencyConflictError) throw new AssessmentHttpError(409,"idempotency_conflict","Idempotency key conflicts with a different request."); throw error;});
  }
  async published(principal:Principal,assessmentId:string) {
    ensureUuid(assessmentId,"assessmentId"); return withTenantTransaction(this.client,{organizationId:principal.organizationId,actorId:principal.userId,correlationId:principal.correlationId},async tx=>{const a=(await tx<{course_id:string;current_published_version_id:string|null}[]>`SELECT course_id,current_published_version_id FROM assessments WHERE organization_id=${principal.organizationId} AND id=${assessmentId}`)[0];if(!a) throw new AssessmentHttpError(404,"not_found","Resource not found.");await member(tx,principal,a.course_id);if(!a.current_published_version_id) throw new AssessmentHttpError(404,"not_found","Resource not found.");return loadVersion(tx,principal.organizationId,a.current_published_version_id,true);});
  }
}
