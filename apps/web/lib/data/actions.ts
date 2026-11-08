"use client";
import type { Goal, PresenceRole, ProposalDetails, VoteChoice } from "@/lib/types";
import { ensureBackend } from "./runtime";

/** Thin async wrappers over the active backend's reducers. Safe to call before the connection is up. */
export async function joinRoom(householdId: string, displayName: string, role: PresenceRole) {
  return (await ensureBackend()).actions.joinRoom(householdId, displayName, role);
}
export async function createSandbox(templateHouseholdId: string, displayName: string) {
  return (await ensureBackend()).actions.createSandbox(templateHouseholdId, displayName);
}
export async function startHuddle(householdId: string, consentNames: string[]) {
  return (await ensureBackend()).actions.startHuddle(householdId, consentNames);
}
export async function appendTranscript(huddleId: string, speaker: string, text: string) {
  return (await ensureBackend()).actions.appendTranscript(huddleId, speaker, text);
}
export async function endHuddle(huddleId: string) {
  return (await ensureBackend()).actions.endHuddle(huddleId);
}
export async function requestSimulation(householdId: string, prompt: string) {
  return (await ensureBackend()).actions.requestSimulation(householdId, prompt);
}
export async function askCoach(householdId: string, text: string, authorName: string) {
  return (await ensureBackend()).actions.askCoach(householdId, text, authorName);
}
export async function ackAlert(alertId: string, displayName: string) {
  return (await ensureBackend()).actions.ackAlert(alertId, displayName);
}
export async function postAdvisorNote(householdId: string, authorName: string, text: string) {
  return (await ensureBackend()).actions.postAdvisorNote(householdId, authorName, text);
}
export async function upsertGoal(goal: Partial<Goal> & { household_id: string; title: string }) {
  return (await ensureBackend()).actions.upsertGoal(goal);
}
export async function deleteGoal(goalId: string) {
  return (await ensureBackend()).actions.deleteGoal(goalId);
}
export async function requestBankSync(householdId: string) {
  return (await ensureBackend()).actions.requestBankSync(householdId);
}
export async function createProposal(input: { householdId: string; title: string; amount: number; details: ProposalDetails; closesInDays: number; authorName: string }) {
  return (await ensureBackend()).actions.createProposal(input);
}
export async function castVote(proposalId: string, choice: VoteChoice, voterName: string) {
  return (await ensureBackend()).actions.castVote(proposalId, choice, voterName);
}
export async function closeProposal(proposalId: string) {
  return (await ensureBackend()).actions.closeProposal(proposalId);
}

export async function addKidTask(input: { householdId: string; memberId: string; title: string; reward: number; authorName: string }) {
  return (await ensureBackend()).actions.addKidTask(input);
}
export async function completeKidTask(taskId: string) {
  return (await ensureBackend()).actions.completeKidTask(taskId);
}
export async function approveKidTask(taskId: string) {
  return (await ensureBackend()).actions.approveKidTask(taskId);
}
export async function reopenKidTask(taskId: string) {
  return (await ensureBackend()).actions.reopenKidTask(taskId);
}
export async function deleteKidTask(taskId: string) {
  return (await ensureBackend()).actions.deleteKidTask(taskId);
}
export async function setKidGoal(householdId: string, memberId: string, title: string, target: number) {
  return (await ensureBackend()).actions.setKidGoal(householdId, memberId, title, target);
}
export async function redeemKidGoal(memberId: string) {
  return (await ensureBackend()).actions.redeemKidGoal(memberId);
}

export async function requestBrianCall(householdId: string, alertId: string, title: string, source: "alert" | "callback" | "demo") {
  return (await ensureBackend()).actions.requestBrianCall(householdId, alertId, title, source);
}
export async function answerBrianCall(callId: string, displayName: string) {
  return (await ensureBackend()).actions.answerBrianCall(callId, displayName);
}
export async function declineBrianCall(callId: string) {
  return (await ensureBackend()).actions.declineBrianCall(callId);
}
export async function expireBrianCall(callId: string) {
  return (await ensureBackend()).actions.expireBrianCall(callId);
}
