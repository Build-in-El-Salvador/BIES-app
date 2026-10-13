import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const NotFound = () => {
    const navigate = useNavigate();
    const { t } = useTranslation();

    return (
        <div className="not-found-page">
            <h1>404</h1>
            <p>{t('notFound.message', 'The page you\'re looking for doesn\'t exist.')}</p>
            <button onClick={() => navigate('/home')} className="btn btn-primary">
                {t('notFound.goHome', 'Go Home')}
            </button>

            <style jsx>{`
                .not-found-page {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    min-height: 60vh;
                    text-align: center;
                    padding: 2rem;
                }
                .not-found-page h1 {
                    font-size: 6rem;
                    font-weight: 800;
                    color: var(--color-primary);
                    margin: 0;
                    line-height: 1;
                }
                .not-found-page p {
                    font-size: 1.15rem;
                    color: var(--color-gray-500);
                    margin: 1rem 0 2rem;
                }
            `}</style>
        </div>
    );
};

export default NotFound;
