/**
 * Fixture data for the test profile. Times are relative to an anchor day D
 * (offset in days, "HH:MM" local in America/New_York) so the profile always
 * looks current. This is never mixed with the real profile: it lives in its
 * own database under data/test.
 */
export interface FxItem {
  key: string;
  type: "task" | "project" | "commitment" | "open_loop" | "goal" | "preference" | "event" | "saved_item";
  title: string;
  status?: string;
  due?: [number, string];
  start?: [number, string];
  end?: [number, string];
  project?: string;
  importance?: number;
  tags?: string[];
  data?: Record<string, unknown>;
  created?: [number, string];
  statusSince?: [number, string];
  touched?: [number, string];
  source?: string;
}

export const COURSES = [
  { code: "CMPSC 465", title: "CMPSC 465 Lecture: Data Structures and Algorithms", days: [1, 3, 5], start: "10:10", end: "11:00", where: "Westgate W201" },
  { code: "CMPSC 473", title: "CMPSC 473 Lecture: Operating Systems", days: [2, 4], start: "13:35", end: "14:50", where: "Thomas 102" },
  { code: "MATH 486", title: "MATH 486 Lecture: Probability Theory", days: [2, 4], start: "09:05", end: "10:20", where: "Osmond 112" },
];

export const CALENDAR: FxItem[] = [
  { key: "lunch", type: "event", title: "Lunch with Arjun", start: [0, "12:15"], end: [0, "13:00"], data: { kind: "social", location: "Pollock Commons" } },
  { key: "oh", type: "event", title: "Office hours with Prof. Lee", start: [2, "15:00"], end: [2, "16:00"], data: { kind: "meeting", location: "Westgate E305" } },
  { key: "robotics", type: "event", title: "Robotics club meeting", start: [1, "18:00"], end: [1, "19:00"], data: { kind: "meeting" } },
  { key: "gym1", type: "event", title: "Gym", start: [1, "07:30"], end: [1, "08:30"], data: { kind: "other" } },
  { key: "gym2", type: "event", title: "Gym", start: [3, "07:30"], end: [3, "08:30"], data: { kind: "other" } },
  { key: "amma", type: "event", title: "Call with Amma", start: [5, "09:30"], end: [5, "10:15"], data: { kind: "social" } },
  { key: "ta", type: "event", title: "CMPSC 465 recitation", start: [-1, "16:00"], end: [-1, "16:50"], data: { kind: "class" } },
];

export const ITEMS: FxItem[] = [
  { key: "p_ava", type: "project", title: "Ava", importance: 3, data: { important: true, next_step: "Wire the activity collector into rhythms" }, created: [-30, "20:00"], touched: [-1, "23:10"] },
  { key: "p_grad", type: "project", title: "Grad school applications", importance: 3, data: { important: true, next_step: "Final pass on the statement of purpose" }, created: [-40, "19:00"], touched: [-4, "22:40"] },
  { key: "p_robot", type: "project", title: "Robotics club: line follower", importance: 2, data: { important: true, next_step: "Tune the PID gains on the new chassis" }, created: [-50, "18:30"], touched: [-9, "19:20"] },
  { key: "p_port", type: "project", title: "Portfolio site", importance: 1, data: { next_step: "Publish the Ava case study" }, created: [-20, "16:00"], touched: [-1, "17:30"] },

  { key: "quiz4", type: "task", title: "CMPSC 465 Quiz 4: shortest paths and MSTs", due: [3, "10:10"], data: { kind: "quiz", course: "CMPSC 465", estimate_minutes: 90 }, tags: ["CMPSC 465"], created: [-6, "11:00"], source: "ics:fixture" },
  { key: "ps5", type: "task", title: "MATH 486 Problem Set 5", due: [1, "23:59"], data: { kind: "assignment", course: "MATH 486", estimate_minutes: 120 }, tags: ["MATH 486"], created: [-7, "10:30"], source: "ics:fixture" },
  { key: "os2", type: "task", title: "OS Project 2: a Unix shell with job control", status: "started", due: [14, "23:59"], project: "p_ava", data: { kind: "assignment", course: "CMPSC 473", estimate_minutes: 600 }, tags: ["CMPSC 473"], created: [-8, "15:00"], statusSince: [-3, "20:00"], source: "ics:fixture" },
  { key: "sop", type: "task", title: "Statement of purpose", status: "drafted", project: "p_grad", data: { kind: "writing", estimate_minutes: 60 }, created: [-25, "21:00"], statusSince: [-4, "22:40"] },
  { key: "recs", type: "task", title: "Send recommender packets to Prof. Lee and Dr. Shah", status: "almost_done", project: "p_grad", data: { estimate_minutes: 30 }, created: [-12, "18:00"], statusSince: [-3, "17:10"] },
  { key: "case", type: "task", title: "Portfolio: Ava case study", status: "almost_done", project: "p_port", data: { estimate_minutes: 45 }, created: [-10, "16:00"], statusSince: [-1, "17:30"] },
  { key: "pid", type: "task", title: "Tune PID gains on the new chassis", project: "p_robot", data: { estimate_minutes: 90 }, created: [-12, "19:00"] },
  { key: "i20", type: "task", title: "Get I-20 travel signature from the international office", due: [9, "16:00"], data: { kind: "errand", estimate_minutes: 30 }, created: [-2, "12:00"] },
  { key: "ddia", type: "task", title: "Read DDIA chapter 5 on replication", data: { kind: "reading", estimate_minutes: 50 }, tags: ["reading"], created: [-5, "23:00"] },

  { key: "riya", type: "commitment", title: "Send Riya the robotics club slides", due: [-1, "18:00"], project: "p_robot", data: { to_person: "Riya", channel: "verbal", quote: "I'll send you the slides by tomorrow evening" }, created: [-3, "19:05"] },
  { key: "lee", type: "open_loop", title: "Reply to Prof. Lee about the research position", data: { kind: "reply_owed", counterpart: "Prof. Lee" }, created: [-5, "09:40"] },
  { key: "dad", type: "commitment", title: "Book flights home for winter break", due: [12, "20:00"], data: { to_person: "Appa" }, created: [-6, "21:30"] },

  { key: "g_phd", type: "goal", title: "Get into a strong systems PhD program", data: { horizon: "this year" }, created: [-60, "20:00"] },
  { key: "g_run", type: "goal", title: "Run a half marathon by March", data: { horizon: "6 months" }, created: [-45, "07:00"] },
];

export const BELIEFS = [
  { area: "routines", statement: "You do your best focused work late, roughly 21:00 to 00:30.", provenance: "stated" as const, confidence: 0.9, daysAgo: 12 },
  { area: "study", statement: "You prefer working practice problems over re-reading notes when preparing for quizzes.", provenance: "stated" as const, confidence: 0.85, daysAgo: 20 },
  { area: "study", statement: "Problem sets usually get finished the night before they're due.", provenance: "observed" as const, confidence: 0.7, daysAgo: 6 },
  { area: "people", statement: "Sunday mornings (State College time) are for calling Amma.", provenance: "stated" as const, confidence: 0.95, daysAgo: 30 },
  { area: "goals", statement: "Systems research is the direction you want for grad school.", provenance: "stated" as const, confidence: 0.9, daysAgo: 40 },
  { area: "projects", statement: "The robotics line follower may matter less to you this semester than it did in spring.", provenance: "inferred" as const, confidence: 0.45, daysAgo: 2 },
  { area: "preferences", statement: "Short, direct messages land better than long ones before noon.", provenance: "inferred" as const, confidence: 0.55, daysAgo: 3 },
];

export const PRACTICE_SET = {
  kind: "practice_set" as const,
  intro: "Twelve questions in the order Quiz 4 is likely to push: Dijkstra's invariants first, then Bellman-Ford, then MSTs. Work each before opening the answer.",
  questions: [
    { q: "Why does Dijkstra's algorithm fail with a negative edge weight, even with no negative cycles? Give a three-vertex example.", answer: "Once a vertex is extracted, its distance is treated as final. With s->a (2), s->b (5), b->a (-4), a is finalized at 2, but the true distance is 1 via b. The greedy invariant needs non-negative weights.", hint: "Think about what 'extracted from the heap' promises." },
    { q: "State the invariant Dijkstra's maintains for the set S of extracted vertices.", answer: "For every v in S, d[v] equals the true shortest-path distance δ(s, v); for every u not in S, d[u] is the shortest path to u using only vertices of S as intermediates." },
    { q: "What is Dijkstra's running time with a binary heap, and where does each term come from?", answer: "O((V + E) log V): V extract-mins and up to E decrease-keys, each O(log V)." },
    { q: "How many rounds of relaxation does Bellman-Ford need, and why that number?", answer: "V − 1. A shortest simple path has at most V − 1 edges, and round i fixes every shortest path with at most i edges." },
    { q: "How does Bellman-Ford detect a negative cycle reachable from s?", answer: "Run one more round after V − 1. If any edge (u, v) still satisfies d[u] + w(u, v) < d[v], a reachable negative cycle exists." },
    { q: "Shortest paths in a DAG with negative weights: what algorithm and what running time?", answer: "Relax edges in topological order: O(V + E). No cycles means no negative cycles, so negative weights are fine." },
    { q: "State the cut property for minimum spanning trees.", answer: "For any cut (S, V − S), a minimum-weight edge crossing the cut belongs to some MST (to every MST if it is the unique minimum)." },
    { q: "Why does Kruskal's algorithm produce an MST?", answer: "Each edge it adds is the lightest edge crossing the cut between the component it joins and the rest; by the cut property it is safe. It skips edges inside a component to avoid cycles." },
    { q: "Kruskal vs Prim on a dense graph (E ≈ V²): which is faster with standard implementations?", answer: "Prim with an adjacency matrix and array scan runs in O(V²), which beats Kruskal's O(E log E) = O(V² log V) on dense graphs." },
    { q: "If every edge weight in a graph is increased by 7, does the MST change? Do shortest paths change?", answer: "The MST doesn't change (every spanning tree gains 7(V − 1)). Shortest paths can change, because paths with more edges are penalized more." },
    { q: "True or false: the MST contains the shortest path between every pair of vertices.", answer: "False. Example: a triangle with weights 1, 1, 1.5. The MST uses the two 1-edges, but the shortest path between their far endpoints is the 1.5 edge." },
    { q: "Give the recurrence behind Floyd-Warshall and its running time.", answer: "d_k[i][j] = min(d_{k−1}[i][j], d_{k−1}[i][k] + d_{k−1}[k][j]); O(V³) time, O(V²) space with in-place updates." },
  ],
};

export const DRAFT_TO_LEE = {
  kind: "draft" as const,
  to: "Prof. Lee",
  subject: "Re: Research position in the systems lab",
  body: "Hi Prof. Lee,\n\nThank you for thinking of me for the position. I'm very interested, especially in the scheduling work you described. I can commit about 10 hours a week this semester and more over winter break.\n\nWould Thursday's office hours be a good time to talk through what the first few weeks would look like?\n\nBest,\nShreyas",
  notes: "Kept it short. Confirm the hours you can commit before sending.",
};

export const BRAIN_DUMP = `okay so a lot is going on. the 465 quiz is thursday and I haven't really started, it's shortest paths and MSTs, I keep telling myself I'll do practice problems but then I end up re-reading the slides which doesn't help. also I told Riya I'd send her the robotics slides yesterday and I completely forgot. the SOP is basically done, it's been sitting there drafted for days, I just need to do the final read but I keep not doing it. OS project two is going okay, I got the parser working. and honestly I'm not sure the line follower thing is worth my time this semester, maybe I should hand it off. oh and I need to get the I-20 signed before winter break, the office is only open weekdays till four`;

export const AVA_REPLY = `The thread worth pulling is the SOP: it's done except for the last read, and that read is maybe forty minutes. [[plan]]I've put tonight's plan up; the read-through sits at nine thirty, inside the window where you usually do your best work.

[[deadlines]]For the quiz, skip the slides. You already know re-reading doesn't stick for you, so I'd go straight to problems. [[opts]]Three ways to start are on screen; I'd take the first.

On the line follower: that's worth deciding rather than letting it drift. If you hand it off, the slides to Riya become the handoff note, which closes two loops at once.`;
