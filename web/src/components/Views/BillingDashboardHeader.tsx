import { motion } from 'framer-motion'
import { Receipt } from 'lucide-react'

export function BillingDashboardHeader() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="order-0 flex items-center gap-3 mb-5"
    >
      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-md ring-1 ring-emerald-400/20">
        <Receipt size={20} strokeWidth={2.25} className="text-white" />
      </div>
      <div>
        <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Billing Dashboard</h2>
        <p className="text-tiny text-ink-3 mt-0.5">Per-client billing config, package pricing and invoice history</p>
      </div>
    </motion.div>
  )
}
