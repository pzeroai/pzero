import ChatPanel from "./components/ChatPanel";
import DashboardGrid from "./components/DashboardGrid";

export default function App() {
  return (
    <div className="h-screen flex flex-col">
      {/* Main */}
      <div className="flex-1 flex min-h-0">
        <ChatPanel />
        <DashboardGrid />
      </div>
    </div>
  );
}
