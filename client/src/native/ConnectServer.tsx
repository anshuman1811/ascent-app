import AscentLogo from '../components/ui/AscentLogo';
import ServerAddressForm from './ServerAddressForm';

// First-run screen in the Android app: no server address saved yet.
export default function ConnectServer({ onConnected }: { onConnected: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <AscentLogo size={48} />
          <h1 className="text-xl font-bold text-white">Connect to your Ascent server</h1>
          <p className="text-sm text-gray-400">
            Enter the address of the computer running Ascent at home. It's shown as
            <span className="text-gray-300"> "Network:" </span>
            when the server starts, for example <code className="text-gray-300">http://192.168.1.20:3001</code>.
          </p>
        </div>
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-4">
          <ServerAddressForm onSaved={onConnected} />
        </div>
        <p className="text-xs text-gray-600 text-center">
          Your phone needs to be on the same Wi-Fi as the server. You can change this later in Settings.
        </p>
      </div>
    </div>
  );
}
