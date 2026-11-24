export default function SectionHeader({ eyebrow, title, text, id, align = 'center' }) {
  return (
    <header className={`section-header section-header--${align}`}>
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h2 id={id}>{title}</h2>
      {text && <p className="text-muted">{text}</p>}
    </header>
  );
}
