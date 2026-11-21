// The diagrams docs pages draw, one file each, all drawn with the helpers in `../svg.tsx`.
// `mdx-components.tsx` passes every export here to MDX by name, so a new diagram needs only its file and a line here.

export { SystemDiagram } from "./system";
export { ConceptsDiagram } from "./concepts";
export { WebAppDiagram } from "./web-app";
export { WorkerDiagram } from "./worker";
export { ComputerDiagram } from "./computer";
export { ThreadDecisionDiagram } from "./thread-decision";
export { RunStatusDiagram } from "./run-status";
export { EgressDiagram } from "./egress";
export { FrameDiagram } from "./frame";
export { LeaseDiagram } from "./lease";
export { ModelAccessDiagram } from "./model-access";
export { NotificationDiagram } from "./notification";
export { SwarmDiagram } from "./swarm";
export { MemoryRecallDiagram } from "./memory-recall";
export { TrustDiagram } from "./trust";
export { DeploymentDiagram } from "./deployment";
