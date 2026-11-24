import { Link } from 'react-router-dom';

// variant: primary | secondary | ghost   size: sm | md | lg
// `to` = in-app route (Link), `href` = plain/external link, otherwise a <button>.
export default function Button({ variant = 'primary', size = 'md', to, href, icon: Icon, children, className = '', ...rest }) {
  const cls = ['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, className].filter(Boolean).join(' ');
  const content = (<>{children}{Icon && <Icon size={18} aria-hidden="true" />}</>);
  if (to) return <Link className={cls} to={to} {...rest}>{content}</Link>;
  if (href) return <a className={cls} href={href} {...rest}>{content}</a>;
  return <button className={cls} type="button" {...rest}>{content}</button>;
}
