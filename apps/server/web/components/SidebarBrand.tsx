/**
 * The product's name and mark at the top of a sidebar.
 *
 * Shared by both screens rather than written twice: the two sidebars sit either
 * side of one toggle, and a heading naming the screen made moving between them read
 * as arriving at a different product. The count beside it is what says which of the
 * two is on view.
 */
export function SidebarBrand(): React.JSX.Element {
  return (
    <div className="sidebar-title">
      <img className="icon" src="/icon-192.png" alt="" width="18" height="18" />
      <h2>TunnelCode</h2>
    </div>
  );
}
