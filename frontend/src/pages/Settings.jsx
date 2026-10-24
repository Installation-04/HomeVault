import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useProperties } from '../property/PropertyContext.jsx';
import AccountSection from '../components/settings/AccountSection.jsx';
import ActivitySection from '../components/settings/ActivitySection.jsx';
import AuditSection from '../components/settings/AuditSection.jsx';
import BackupSection from '../components/settings/BackupSection.jsx';
import CalendarLinksSection from '../components/settings/CalendarLinksSection.jsx';
import MembersSection from '../components/settings/MembersSection.jsx';
import PropertySection from '../components/settings/PropertySection.jsx';
import SessionsSection from '../components/settings/SessionsSection.jsx';
import TwoFactorSection from '../components/settings/TwoFactorSection.jsx';
import UsersAdminSection from '../components/settings/UsersAdminSection.jsx';

// Four areas, deep-linkable as /settings?tab=security etc.
export default function Settings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { current, canEdit } = useProperties();
  const [params, setParams] = useSearchParams();
  // Bumped when a security change (2FA on/off) alters the device list and activity feed below it.
  const [securityVersion, setSecurityVersion] = useState(0);

  const tabs = [
    { id: 'property', label: t('settings.tab_property') },
    { id: 'account', label: t('settings.tab_account') },
    { id: 'security', label: t('settings.tab_security') },
    { id: 'calendar', label: t('settings.tab_calendar') },
    ...(user.is_admin ? [{ id: 'admin', label: t('settings.tab_admin') }] : []),
  ];
  const active = tabs.some((x) => x.id === params.get('tab')) ? params.get('tab') : 'property';

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="font-semibold text-lg">{t('nav.settings')}</h1>

      <div role="tablist" aria-label={t('nav.settings')} className="flex gap-1 overflow-x-auto border-b -mx-1 px-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            onClick={() => setParams(tab.id === 'property' ? {} : { tab: tab.id }, { replace: true })}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
              active === tab.id ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} className="space-y-4">
        {active === 'property' && (
          <>
            {current ? (
              <>
                <PropertySection property={current} canEdit={canEdit} />
                {canEdit && <MembersSection property={current} isAdmin={user.is_admin} />}
              </>
            ) : (
              <p className="text-gray-500">{t('dashboard.no_properties')}</p>
            )}
          </>
        )}
        {active === 'account' && <AccountSection />}
        {active === 'security' && (
          <>
            <TwoFactorSection onChanged={() => setSecurityVersion((v) => v + 1)} />
            <SessionsSection key={`s${securityVersion}`} />
            <ActivitySection key={`a${securityVersion}`} />
          </>
        )}
        {active === 'calendar' && <CalendarLinksSection />}
        {active === 'admin' && user.is_admin && (
          <>
            <UsersAdminSection />
            <AuditSection />
            <BackupSection />
          </>
        )}
      </div>
    </div>
  );
}
