// Barrel module: startup phases were split into sibling files to keep
// each phase reviewable in isolation. Import sites depend on this
// module's public surface, so additions/removals here are the only
// place to coordinate.

export { applyRotationPhase } from './phase-rotation.js';
export { resolveProvider } from './phase-provider-selection.js';
export { authenticateAndConnect } from './phase-provider-connect.js';
export { selectAndValidateModel } from './phase-model-selection.js';
export { installShutdownHandlers, gatherGitState } from './phase-runtime-lifecycle.js';
export { handleProjectTrust, registerSubagentTool } from './phase-trust-and-subagent.js';
