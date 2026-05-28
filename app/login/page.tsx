import LoginForm from './LoginForm'

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* ロゴ・タイトル */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">みそ熟成管理</h1>
          <p className="mt-1 text-sm text-gray-500">ログイン</p>
        </div>

        {/* ログインカード */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-8">
          <LoginForm />
        </div>
      </div>
    </div>
  )
}
