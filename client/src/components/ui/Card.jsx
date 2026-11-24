// Generic card. Optional icon (Lucide component), title and text; children render below.
export default function Card({ icon: Icon, title, text, interactive = false, children, className = '' }) {
  return (
    <article className={['card', interactive && 'card--interactive', className].filter(Boolean).join(' ')}>
      {Icon && <div className="card__icon"><Icon size={22} aria-hidden="true" /></div>}
      {title && <h3 className="card__title">{title}</h3>}
      {text && <p className="card__text">{text}</p>}
      {children}
    </article>
  );
}
