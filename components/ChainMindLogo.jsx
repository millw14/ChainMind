// The in-app header mark: the real ChainMind logo (split circle — chain link +
// brain circuit), cropped from the brand artwork to the mark alone since the
// word "ChainMind" already sits beside it in the header.
export function ChainMindLogo({ size = 28 }) {
  return (
    <img
      src="/chainmind-logo.png"
      width={size}
      height={size}
      alt="ChainMind"
      className="block"
    />
  );
}
