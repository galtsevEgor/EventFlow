export function Brand({ href = '/', caption }: { href?: string; caption?: string }) {
  return (
    <a className="brand" href={href}>
      <span className="ef-brand-mark" aria-hidden="true" />
      <span className="brand-copy">
        EventFlow
        {caption && <small>{caption}</small>}
      </span>
    </a>
  );
}
