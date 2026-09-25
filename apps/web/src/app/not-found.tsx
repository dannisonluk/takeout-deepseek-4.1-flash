import Link from 'next/link';

/**
 * The 404.
 *
 * A server component so it costs no client JavaScript, and deliberately plain:
 * this is the page a mistyped share link lands on, so the useful thing is a way
 * back to the discovery grid rather than an illustration.
 */
export default function NotFound() {
  return (
    <div className="page" style={{ maxWidth: 520 }}>
      <div className="stack" style={{ paddingTop: 'var(--space-7)' }}>
        <div className="stack-sm" style={{ gap: 4 }}>
          <span className="dim mono" style={{ fontSize: 12 }}>
            404
          </span>
          <h1>找不到這個頁面</h1>
          <p className="muted">
            連結可能已失效，或餐廳已結業。你可以回到首頁重新搜尋。
          </p>
        </div>

        <div className="row">
          <Link href="/" className="btn btn-primary">
            返回首頁
          </Link>
          <Link href="/orders" className="btn">
            我的訂單
          </Link>
        </div>
      </div>
    </div>
  );
}
