import assert from "node:assert/strict";
import test from "node:test";
import { CreateAssessmentDraftRequestSchema } from "../src/v1/api.ts";

const input = {
  title: "Synthetic assessment", assignment_instructions: "Explain your validation choice.",
  objectives: ["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"].map((id,index)=>({id,label:`Objective ${index+1}`,description:"A synthetic objective.",evidence_criteria:"Cited explanation.",assessable_in_check_in:true})),
  rubric:[{label:"Criterion",description:"Synthetic rubric.",evidence_criteria:"Cited evidence.",objective_ids:["11111111-1111-4111-8111-111111111111"]}],
  policy:{learner_facing_text:"Text is available.",ai_use_policy:"allowed",privacy_summary:"Synthetic only.",completion_criteria:"Complete three answers."},
  accommodations:{text_check_in:true,voice_check_in:false,extra_time:true,pause_and_resume:true,alternative_assessment_request:true},question_budget:3,time_budget_minutes:3,
};
test("complete durable assessment draft contract is strict and preserves explicit rubric mappings",()=>{
  assert.deepEqual(CreateAssessmentDraftRequestSchema.parse(input),input);
  assert.throws(()=>CreateAssessmentDraftRequestSchema.parse({...input, grade: 1}),/prohibited/i);
  assert.throws(()=>CreateAssessmentDraftRequestSchema.parse({...input,accommodations:{...input.accommodations,text_check_in:false}}),/Typed check-in/);
  assert.throws(()=>CreateAssessmentDraftRequestSchema.parse({...input,rubric:[{...input.rubric[0],objective_ids:["unknown"]}]}),/supplied objectives/);
});
