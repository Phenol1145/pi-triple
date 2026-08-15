# Pi-Triple / PTH

Pi-Triple combines PTL, a local interactive development product, with PTH, a server-side task platform. This glossary records the stable language for the PTH modularisation work; it deliberately describes domain concepts rather than directory names or implementation choices.

## Product composition

**PTH Host**:
The process that selects a product profile, composes approved modules, and owns their lifecycle.
_Avoid_: Core, kernel server, application singleton

**Profile**:
A supported product shape made by selecting a fixed set of PTH modules and adapters at build or deployment time.
_Avoid_: Fork, edition branch, dynamic plugin set

**Module**:
A capability boundary with a public application API, owned rules, and owned state. A module can change internally without exposing its repositories or infrastructure objects.
_Avoid_: Directory, layer, utility collection

**Adapter**:
An implementation of a module-facing port for a concrete technology or external process.
_Avoid_: Core service, business module

## Task execution

**Task Control**:
The authority that accepts, routes, leases, cancels, and records tasks. It owns task state transitions.
_Avoid_: Kernel, worker pool

**Task Runner**:
The capability that receives a leased task, coordinates agent work, and returns an outcome. It does not own task state.
_Avoid_: Task control, scheduler

**Execution Runtime**:
The language-agnostic capability that runs approved code and reports an execution result.
_Avoid_: Task runtime, sandbox

**Task Lease**:
A time-bounded authority to process one routed task for one tenant and workspace.
_Avoid_: Task ID, worker ownership

**Execution Grant**:
A short-lived, single-purpose authority for one execution request, bound to a task lease, tenant, workspace, capabilities, and deadline.
_Avoid_: Shared sandbox secret, kernel ID

## Shared capabilities

**Runtime Catalog**:
An explicit, immutable-at-use collection of roles, spaces, capabilities, and approved extension contributions for one Host or Runner instance.
_Avoid_: Global registry, singleton configuration

**Knowledge**:
The capability that owns memory, retrieval, refinement, and visibility rules.
_Avoid_: Data world, shared store

**Extension Contribution**:
An approved declaration of a role, space, tool, execution adapter, or observer that a module may add to the Runtime Catalog.
_Avoid_: Arbitrary host plugin, unrestricted eval code
