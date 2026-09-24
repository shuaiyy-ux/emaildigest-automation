/**
 * Aurora background — near-black base with two slowly drifting blue/violet
 * blobs and a faint grain overlay. HANDOFF §2.
 *
 * Sits behind all content at `z-index: -10`. Fixed, non-interactive.
 */
export function Background() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none" style={{ backgroundColor: "var(--bg-base)" }}>
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1400px 800px at 15% -5%, rgba(122,183,255,0.07), transparent 60%)," +
            "radial-gradient(1100px 700px at 105% 110%, rgba(196,181,253,0.05), transparent 55%)",
        }}
      />
      <div
        className="absolute w-[560px] h-[560px] rounded-full blur-[120px] opacity-[.18] mix-blend-screen -left-40 -top-32"
        style={{ background: "#3a86ff", animation: "drift 40s ease-in-out infinite alternate" }}
      />
      <div
        className="absolute w-[520px] h-[520px] rounded-full blur-[120px] opacity-[.18] mix-blend-screen -right-40 -bottom-32"
        style={{ background: "#8b5cf6", animation: "drift 48s -12s ease-in-out infinite alternate" }}
      />
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.6'/></svg>\")",
        }}
      />
    </div>
  );
}
